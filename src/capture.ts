// Capture daemon: an activity-gated pipeline. We pull MJPEG frames from the camera, decode
// each to a small grayscale image and run the activity detector BEFORE encoding. A GOP of
// frames is H.264-encoded only if something actually moved; otherwise we write a tiny
// "no-change" record (no video) that references the last encoded frame. This skips the encode
// cost for static scenes. Separate process from the server. Run: yarn typenode ./src/capture.ts

import { spawn, ChildProcess } from "child_process";
import { VIDEO_DEVICE, WIDTH, HEIGHT, FPS, BITRATE, GOP } from "./config";
import { AnnexBSplitter, nalType } from "./annexb";
import { StorageWriter, enforceRetention } from "./storage";
import { ProcCpuSampler, writeEncoderStats } from "./stats";
import { ActivityModel, FRAME as GRAY_BYTES, W as GW, H as GH } from "./activityDetect";
import { getTimezone } from "./timezone";

// Local timezone for the on-disk date folders and the burned-in clock overlay.
process.env.TZ = getTimezone();

const ACTIVITY_THRESHOLD = 0.0001;   // GOP max activity below this -> don't encode
const SOI = Buffer.from([0xff, 0xd8]); // JPEG start-of-image
const EOI = Buffer.from([0xff, 0xd9]); // JPEG end-of-image

const writer = new StorageWriter();
const model = new ActivityModel();

// ---- MJPEG byte-stream -> individual JPEG frames ----
class JpegSplitter {
    private buf = Buffer.alloc(0);
    push(chunk: Buffer): Buffer[] {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        const out: Buffer[] = [];
        while (true) {
            const soi = this.buf.indexOf(SOI);
            if (soi < 0) { if (this.buf.length > 1) this.buf = this.buf.subarray(this.buf.length - 1); break; }
            if (soi > 0) this.buf = this.buf.subarray(soi); // drop junk before SOI
            const eoi = this.buf.indexOf(EOI, 2);
            if (eoi < 0) break;                              // frame not complete yet
            out.push(Buffer.from(this.buf.subarray(0, eoi + 2)));
            this.buf = Buffer.from(this.buf.subarray(eoi + 2));
        }
        return out;
    }
}

type Frame = { jpeg: Buffer; t: number; pushTs: number };
const awaitingGray: Frame[] = [];               // frames pushed to the gray decoder, awaiting their gray result
let curGop: { frames: Frame[]; maxAct: number } = { frames: [], maxAct: 0 };
const writeQueue: { frames: Frame[]; t: number; maxAct: number }[] = [];
let writing = false;
let lastEncodedT: number | undefined;           // start time of the last encoded GOP (the no-change reference)

// rolling timing accumulators (averaged + reset every stats tick)
let dSum = 0, dCount = 0, aSum = 0, aCount = 0, eSum = 0, eCount = 0;
let framesWritten = 0;

let capProc: ChildProcess | undefined, grayProc: ChildProcess | undefined;
let capSampler: ProcCpuSampler | undefined, graySampler: ProcCpuSampler | undefined;
const jpegSplit = new JpegSplitter();
let grayPending = Buffer.alloc(0);

function onJpeg(jpeg: Buffer): void {
    const f: Frame = { jpeg, t: Date.now(), pushTs: performance.now() };
    awaitingGray.push(f);
    try { grayProc?.stdin?.write(jpeg); } catch { /* */ }
}

function onGray(gray: Buffer): void {
    const f = awaitingGray.shift();
    if (!f) return;
    dSum += performance.now() - f.pushTs; dCount++;     // JPEG-decode latency (push -> gray out)
    const a0 = performance.now();
    const act = model.compute(gray);
    aSum += performance.now() - a0; aCount++;
    curGop.frames.push(f);
    if (act > curGop.maxAct) curGop.maxAct = act;
    if (curGop.frames.length >= GOP) {
        writeQueue.push({ frames: curGop.frames, t: curGop.frames[0].t, maxAct: curGop.maxAct });
        curGop = { frames: [], maxAct: 0 };
        framesWritten += GOP;
        void drainWrites();
    }
}

// Process finalized GOPs in order (serially) so index records stay ordered: encode active
// GOPs, write no-change records for static ones.
async function drainWrites(): Promise<void> {
    if (writing) return;
    writing = true;
    try {
        while (writeQueue.length) {
            const g = writeQueue.shift()!;
            // Always encode the first GOP (establishes a reference frame), then encode only
            // when there's activity; otherwise write a no-change record.
            if (g.maxAct >= ACTIVITY_THRESHOLD || lastEncodedT === undefined) {
                await encodeGop(g.frames, g.t, g.maxAct);
                lastEncodedT = g.t;
            } else {
                await writer.writeNoChange(g.t, lastEncodedT, g.frames.length);
            }
        }
    } finally { writing = false; }
}

// Encode one GOP's JPEGs to H.264 via a short gst run (jpegdec -> clockoverlay -> v4l2h264enc),
// like the thinning re-encoder. Resolves once the GOP is written.
function encodeGop(frames: Frame[], t: number, maxAct: number): Promise<void> {
    return new Promise<void>(resolve => {
        const t0 = performance.now();
        const enc = spawn("gst-launch-1.0", [
            "-q", "fdsrc", "fd=0", "!", "jpegdec", "!", "videoconvert", "!",
            "clockoverlay", "time-format=%Y-%m-%d %I:%M:%S %p %Z", "font-desc=Sans Bold 18", "!",
            "v4l2h264enc", `extra-controls=encode,video_bitrate=${BITRATE},h264_i_frame_period=${GOP}`, "!",
            "video/x-h264,level=(string)4,profile=main", "!",
            "h264parse", "config-interval=1", "!",
            "video/x-h264,stream-format=byte-stream,alignment=au", "!",
            "fdsink", "fd=1",
        ], { stdio: ["pipe", "pipe", "ignore"] });
        const split = new AnnexBSplitter();
        let sps: Buffer | undefined, pps: Buffer | undefined;
        const slices: Buffer[] = [];
        const onNal = (nal: Buffer) => { const ty = nalType(nal); if (ty === "sps") sps = nal; else if (ty === "pps") pps = nal; else if (ty === "idr" || ty === "nonidr") slices.push(nal); };
        enc.stdout?.on("data", (c: Buffer) => { for (const n of split.push(c)) onNal(n); });
        enc.on("close", () => {
            for (const n of split.flush()) onNal(n);
            const nals: Buffer[] = [];
            if (sps) nals.push(sps);
            if (pps) nals.push(pps);
            nals.push(...slices);
            if (slices.length > 0) void writer.writeGop(nals, t, slices.length, maxAct);
            eSum += performance.now() - t0; eCount++;
            resolve();
        });
        enc.on("error", () => resolve());
        enc.stdin?.on("error", () => { /* ignore EPIPE if encoder died */ });
        for (const f of frames) { try { enc.stdin?.write(f.jpeg); } catch { /* */ } }
        try { enc.stdin?.end(); } catch { /* */ }
    });
}

function start(): void {
    console.log(`[capture] starting activity-gated pipeline ${WIDTH}x${HEIGHT}@${FPS}`);
    jpegSplit.push(Buffer.alloc(0)); // (no-op, keeps splitter referenced)
    awaitingGray.length = 0;
    curGop = { frames: [], maxAct: 0 };
    grayPending = Buffer.alloc(0);

    capProc = spawn("gst-launch-1.0", [
        "-q", "v4l2src", `device=${VIDEO_DEVICE}`, "!",
        `image/jpeg,width=${WIDTH},height=${HEIGHT},framerate=${FPS}/1`, "!",
        "fdsink", "fd=1",
    ], { stdio: ["ignore", "pipe", "inherit"] });

    grayProc = spawn("gst-launch-1.0", [
        "-q", "fdsrc", "fd=0", "!", "jpegdec", "!", "videoconvert", "!", "videoscale", "!",
        `video/x-raw,format=GRAY8,width=${GW},height=${GH}`, "!", "fdsink", "fd=1",
    ], { stdio: ["pipe", "pipe", "ignore"] });

    capSampler = capProc.pid ? new ProcCpuSampler(capProc.pid) : undefined;
    graySampler = grayProc.pid ? new ProcCpuSampler(grayProc.pid) : undefined;

    capProc.stdout?.on("data", (c: Buffer) => { for (const j of jpegSplit.push(c)) onJpeg(j); });
    grayProc.stdout?.on("data", (c: Buffer) => {
        grayPending = grayPending.length ? Buffer.concat([grayPending, c]) : c;
        while (grayPending.length >= GRAY_BYTES) {
            onGray(Buffer.from(grayPending.subarray(0, GRAY_BYTES)));
            grayPending = grayPending.subarray(GRAY_BYTES);
        }
    });

    const restart = (who: string) => (code: number | null, signal: string | null) => {
        console.error(`[capture] ${who} exited code=${code} signal=${signal}; restarting in 2s`);
        try { capProc?.kill(); } catch { /* */ }
        try { grayProc?.kill(); } catch { /* */ }
        capProc = grayProc = undefined;
        setTimeout(start, 2000);
    };
    let restarted = false;
    const once = (who: string) => (code: number | null, signal: string | null) => { if (restarted) return; restarted = true; restart(who)(code, signal); };
    capProc.on("exit", once("capture"));
    grayProc.on("exit", once("gray-decode"));
    capProc.on("error", (e) => console.error("[capture] cap spawn error:", e.message));
    grayProc.on("error", (e) => console.error("[capture] gray spawn error:", e.message));
}

// Sample throughput + CPU + stage timings every 5s for the server to read. FPS over a ~15s
// sliding window so a brief dip is visible without the number being jumpy.
const FPS_WINDOW_MS = 15_000;
const fpsHist: { ms: number; frames: number }[] = [];
setInterval(async () => {
    try {
        const now = Date.now();
        fpsHist.push({ ms: now, frames: framesWritten });
        while (fpsHist.length > 2 && now - fpsHist[0].ms > FPS_WINDOW_MS) fpsHist.shift();
        const base = fpsHist[0];
        const dt = (now - base.ms) / 1000;
        const fps = dt > 0 ? (framesWritten - base.frames) / dt : 0;
        const cpuPct = Math.round((capSampler ? await capSampler.sample() : 0) + (graySampler ? await graySampler.sample() : 0));
        const jpegDecodeMs = dCount ? dSum / dCount : 0;
        const activityMs = aCount ? aSum / aCount : 0;
        const encodeMs = eCount ? eSum / eCount : 0;
        dSum = dCount = aSum = aCount = eSum = eCount = 0;
        await writeEncoderStats({ fps: Math.round(fps * 10) / 10, cpuPct, updatedMs: now, jpegDecodeMs, activityMs, encodeMs });
    } catch (e) { console.error("[capture] stats failed:", (e as Error).message); }
}, 5000);

// Enforce the rolling byte cap every 60s.
setInterval(async () => {
    try {
        const r = await enforceRetention();
        if (r.deleted.length) console.log(`[capture] retention: deleted ${r.deleted.length} file pair(s), now ${(r.totalBytes / 1e9).toFixed(2)} GB`);
    } catch (e) { console.error("[capture] retention failed:", (e as Error).message); }
}, 60_000);

start();
