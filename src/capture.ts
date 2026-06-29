// Capture daemon — ONE persistent ffmpeg, hardware H.264 encoder. The camera's MJPEG is decoded
// once and split in-process to two compact output pipes, so the full-resolution frames never
// enter Node (routing them through JS couldn't sustain 30 fps on this Pi):
//   • pipe:3 — continuous H.264 (h264_v4l2m2m HW encoder, forced IDR every GOP frames);
//   • pipe:4 — the same frames scaled to a tiny grayscale image for the activity detector.
// Node reads only these (~0.6 MB/s H.264 + ~0.25 MB/s gray). The H.264 stream is split into GOPs
// at the forced IDR boundaries; a GOP with activity is stored, a static one becomes a no-change
// record (bytes discarded). The split keeps the two pipes frame-for-frame aligned, so each output
// GOP maps to its gray frames by index. Activity runs on a WORKER THREAD (off the main loop), and
// the clock is overlaid client-side at playback (no SW drawtext — it pushed the encoder under
// realtime). Run: yarn typenode ./src/capture.ts

import { spawn, ChildProcess } from "child_process";
import { Worker } from "worker_threads";
import { Readable } from "stream";
import * as path from "path";
import { VIDEO_DEVICE, WIDTH, HEIGHT, FPS, BITRATE, GOP } from "./config";
import { AnnexBSplitter, nalType } from "./annexb";
import { StorageWriter, enforceRetention, actToU16 } from "./storage";
import { ProcCpuSampler, writeEncoderStats } from "./stats";
import { FRAME as GRAY_BYTES, W as GW, H as GH } from "./activityDetect";
import { getTimezone } from "./timezone";

process.env.TZ = getTimezone();

const ACTIVITY_THRESHOLD = 0.0001;          // GOP max activity below this -> no encode (static)

const writer = new StorageWriter();

// Activity detector on its own thread. The main loop posts each gray frame in (keyed by seq) and
// gets {seq, act} back; it never runs the (synchronous) detector itself.
const worker = new Worker(path.join(__dirname, "activityWorker.ts"), { execArgv: process.execArgv });
const actBySeq = new Map<number, number>();
worker.on("message", (m: { seq: number; act: number; ms: number }) => { actBySeq.set(m.seq, m.act); aSum += m.ms; aCount++; });
worker.on("error", (e: Error) => console.error("[capture] activity worker error:", e.message));

// Per-frame bookkeeping. Frames are indexed in arrival order on each pipe; the split keeps the
// gray pipe and the H.264 pipe 1:1, so frame index `seq` means the same frame on both.
let graySeq = 0;                                   // next gray-frame index (== capture order)
let encSeq = 0;                                    // next H.264-frame index consumed by a GOP
const seqInfo = new Map<number, { t: number; pushTs: number }>(); // capture time per in-flight seq
let lastEncodedT: number | undefined;

let aSum = 0, aCount = 0, eSum = 0, eCount = 0, framesWritten = 0;
let proc: ChildProcess | undefined;
let sampler: ProcCpuSampler | undefined;
let grayPending = Buffer.alloc(0);

// Persistent-encoder output: split the continuous H.264 stream into GOPs at IDR boundaries. SPS/PPS
// are cached and prepended to every stored GOP so each is independently decodable.
const encSplit = new AnnexBSplitter();
let encSps: Buffer | undefined, encPps: Buffer | undefined;
let encCur: Buffer[] | null = null; // slices of the GOP being assembled (idr + p-frames)

// A gray frame arrived: stamp its capture time and hand it to the worker for activity. No blocking
// work — the encoder is fed by ffmpeg directly, and activity comes back asynchronously (matched by
// seq when the GOP finalizes).
function onGray(gray: Buffer): void {
    const seq = graySeq++;
    seqInfo.set(seq, { t: Date.now(), pushTs: performance.now() });
    framesWritten++;
    worker.postMessage({ seq, gray });
}

function onEncNal(nal: Buffer): void {
    const ty = nalType(nal);
    if (ty === "sps") encSps = nal;
    else if (ty === "pps") encPps = nal;
    else if (ty === "idr") { if (encCur) finalizeEnc(encCur); encCur = [nal]; }
    else if (ty === "nonidr") { if (encCur) encCur.push(nal); }
    // GOPs are forced to exactly GOP frames; finalize as soon as we have them (don't wait for the
    // next IDR — that would add a whole GOP of latency).
    if (encCur && encCur.length >= GOP) { finalizeEnc(encCur); encCur = null; }
}

// One completed encoder GOP: its slices are frames [encSeq, encSeq+n). Gather their capture time +
// per-frame activity (computed by the worker, ready by now — it has no encoder buffering), then
// store the bytes (activity) or write a no-change record (static — discard bytes).
function finalizeEnc(slices: Buffer[]): void {
    const n = slices.length;
    if (n === 0) return;
    const base = encSeq;
    encSeq += n;
    const first = seqInfo.get(base), last = seqInfo.get(base + n - 1);
    const t = first ? first.t : Date.now();
    const acts = new Uint16Array(n);
    let mx = 0;
    for (let i = 0; i < n; i++) { const a = actBySeq.get(base + i) ?? 0; acts[i] = actToU16(a); if (a > mx) mx = a; }
    if (last) { eSum += performance.now() - last.pushTs; eCount++; } // encoder pipeline latency
    for (let i = 0; i < n; i++) { seqInfo.delete(base + i); actBySeq.delete(base + i); }
    if (mx >= ACTIVITY_THRESHOLD || lastEncodedT === undefined) {
        const nals: Buffer[] = [];
        if (encSps) nals.push(encSps);
        if (encPps) nals.push(encPps);
        nals.push(...slices);
        void writer.writeGop(nals, t, n, acts);
        lastEncodedT = t;
    } else {
        void writer.writeNoChange(t, lastEncodedT, acts);
    }
}

function start(): void {
    console.log(`[capture] starting single-ffmpeg persistent-encoder pipeline ${WIDTH}x${HEIGHT}@${FPS}`);
    graySeq = 0; encSeq = 0; seqInfo.clear(); actBySeq.clear(); grayPending = Buffer.alloc(0);
    encCur = null; encSps = encPps = undefined;

    // Decode the camera MJPEG once, split to: [e] full-res yuv420p -> HW H.264 (pipe:3), and
    // [a] tiny grayscale for activity (pipe:4). fd3/fd4 are the two extra output pipes.
    proc = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-f", "v4l2", "-input_format", "mjpeg", "-framerate", String(FPS), "-video_size", `${WIDTH}x${HEIGHT}`,
        "-i", VIDEO_DEVICE,
        "-filter_complex", `[0:v]split=2[e0][a0];[e0]format=yuv420p[e];[a0]scale=${GW}:${GH},format=gray[a]`,
        "-map", "[e]", "-c:v", "h264_v4l2m2m", "-b:v", String(BITRATE), "-g", String(GOP),
        "-force_key_frames", `expr:gte(n,n_forced*${GOP})`, "-flush_packets", "1", "-f", "h264", "pipe:3",
        "-map", "[a]", "-f", "rawvideo", "pipe:4",
    ], { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] });

    sampler = proc.pid ? new ProcCpuSampler(proc.pid) : undefined;

    const h264 = proc.stdio[3] as Readable | null;
    const gray = proc.stdio[4] as Readable | null;
    h264?.on("data", (c: Buffer) => { for (const n of encSplit.push(c)) onEncNal(n); });
    gray?.on("data", (c: Buffer) => {
        grayPending = grayPending.length ? Buffer.concat([grayPending, c]) : c;
        while (grayPending.length >= GRAY_BYTES) {
            onGray(Buffer.from(grayPending.subarray(0, GRAY_BYTES)));
            grayPending = grayPending.subarray(GRAY_BYTES);
        }
    });

    let restarted = false;
    const restart = (why: string) => {
        if (restarted) return; restarted = true;
        console.error(`[capture] ${why}; restarting in 2s`);
        try { proc?.kill("SIGKILL"); } catch { /* */ }
        proc = undefined;
        setTimeout(start, 2000);
    };
    proc.on("exit", (code, signal) => restart(`ffmpeg exited code=${code} signal=${signal}`));
    proc.on("error", e => restart(`ffmpeg spawn error: ${e.message}`));
}

// Stats every 5s: fps (15s sliding), ffmpeg CPU, stage timings (decode is in-ffmpeg so not
// separately timed; activity = worker compute; encode = camera->GOP pipeline latency).
const FPS_WINDOW_MS = 15_000;
const fpsHist: { ms: number; frames: number }[] = [];
setInterval(async () => {
    try {
        const now = Date.now();
        fpsHist.push({ ms: now, frames: framesWritten });
        while (fpsHist.length > 2 && now - fpsHist[0].ms > FPS_WINDOW_MS) fpsHist.shift();
        const dt = (now - fpsHist[0].ms) / 1000;
        const fps = dt > 0 ? (framesWritten - fpsHist[0].frames) / dt : 0;
        const cpuPct = Math.round(sampler ? await sampler.sample() : 0);
        const activityMs = aCount ? aSum / aCount : 0, encodeMs = eCount ? eSum / eCount : 0;
        aSum = aCount = eSum = eCount = 0;
        await writeEncoderStats({ fps: Math.round(fps * 10) / 10, cpuPct, updatedMs: now, jpegDecodeMs: 0, activityMs, encodeMs });
    } catch (e) { console.error("[capture] stats failed:", (e as Error).message); }
}, 5000);

setInterval(async () => {
    try { const r = await enforceRetention(); if (r.deleted.length) console.log(`[capture] retention: deleted ${r.deleted.length} pair(s), now ${(r.totalBytes / 1e9).toFixed(2)} GB`); }
    catch (e) { console.error("[capture] retention failed:", (e as Error).message); }
}, 60_000);

start();
