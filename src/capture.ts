// Capture daemon — ffmpeg, activity-gated. Pulls MJPEG from the camera (ffmpeg copy, ~free),
// decodes each frame at 1/8 scale (ffmpeg -lowres 3 → 240×135 gray) to run the activity
// detector BEFORE encoding, and H.264-encodes a GOP (ffmpeg h264_v4l2m2m, hardware) only if it
// contains activity; otherwise writes a tiny "no-change" record referencing the last encoded
// frame. Per-frame activity is recorded. No GStreamer. Run: yarn typenode ./src/capture.ts

import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import { VIDEO_DEVICE, WIDTH, HEIGHT, FPS, BITRATE, GOP } from "./config";
import { AnnexBSplitter, nalType } from "./annexb";
import { StorageWriter, enforceRetention, actToU16 } from "./storage";
import { ProcCpuSampler, writeEncoderStats } from "./stats";
import { ActivityModel, FRAME as GRAY_BYTES, W as GW, H as GH } from "./activityDetect";
import { getTimezone } from "./timezone";

process.env.TZ = getTimezone();

const ACTIVITY_THRESHOLD = 0.0001;          // GOP max activity below this -> no encode
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const HAVE_FONT = (() => { try { return fs.existsSync(FONT); } catch { return false; } })();

const writer = new StorageWriter();
const model = new ActivityModel();

// MJPEG byte-stream -> individual JPEG frames.
class JpegSplitter {
    private buf = Buffer.alloc(0);
    push(chunk: Buffer): Buffer[] {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        const out: Buffer[] = [];
        while (true) {
            const soi = this.buf.indexOf(SOI);
            if (soi < 0) { if (this.buf.length > 1) this.buf = this.buf.subarray(this.buf.length - 1); break; }
            if (soi > 0) this.buf = this.buf.subarray(soi);
            const eoi = this.buf.indexOf(EOI, 2);
            if (eoi < 0) break;
            out.push(Buffer.from(this.buf.subarray(0, eoi + 2)));
            this.buf = Buffer.from(this.buf.subarray(eoi + 2));
        }
        return out;
    }
}

type Frame = { jpeg: Buffer; t: number; pushTs: number; act: number };
const awaitingGray: Frame[] = [];
let curGop: Frame[] = [];
const writeQueue: Frame[][] = [];
let writing = false;
let lastEncodedT: number | undefined;

let dSum = 0, dCount = 0, aSum = 0, aCount = 0, eSum = 0, eCount = 0, framesWritten = 0;
let capProc: ChildProcess | undefined, grayProc: ChildProcess | undefined;
let capSampler: ProcCpuSampler | undefined, graySampler: ProcCpuSampler | undefined;
const jpegSplit = new JpegSplitter();
let grayPending = Buffer.alloc(0);

function onJpeg(jpeg: Buffer): void {
    const f: Frame = { jpeg, t: Date.now(), pushTs: performance.now(), act: 0 };
    awaitingGray.push(f);
    try { grayProc?.stdin?.write(jpeg); } catch { /* */ }
}

function onGray(gray: Buffer): void {
    const f = awaitingGray.shift();
    if (!f) return;
    dSum += performance.now() - f.pushTs; dCount++;
    const a0 = performance.now();
    f.act = model.compute(gray);
    aSum += performance.now() - a0; aCount++;
    curGop.push(f);
    if (curGop.length >= GOP) {
        writeQueue.push(curGop);
        curGop = [];
        framesWritten += GOP;
        void drainWrites();
    }
}

// Serialize GOP writes so index records stay ordered.
async function drainWrites(): Promise<void> {
    if (writing) return;
    writing = true;
    try {
        while (writeQueue.length) {
            const frames = writeQueue.shift()!;
            const acts = new Uint16Array(frames.length);
            let mx = 0;
            for (let i = 0; i < frames.length; i++) { acts[i] = actToU16(frames[i].act); if (frames[i].act > mx) mx = frames[i].act; }
            const t = frames[0].t;
            if (mx >= ACTIVITY_THRESHOLD || lastEncodedT === undefined) {
                await encodeGop(frames, t, acts);
                lastEncodedT = t;
            } else {
                await writer.writeNoChange(t, lastEncodedT, acts);
            }
        }
    } finally { writing = false; }
}

// Encode a GOP's JPEGs to H.264 via a short ffmpeg run (hardware h264_v4l2m2m).
function encodeGop(frames: Frame[], t: number, acts: Uint16Array): Promise<void> {
    return new Promise<void>(resolve => {
        const t0 = performance.now();
        const vf = (HAVE_FONT ? `drawtext=fontfile=${FONT}:text='%{localtime}':x=12:y=10:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.5,` : "") + "format=yuv420p";
        const enc = spawn("ffmpeg", [
            "-hide_banner", "-loglevel", "error",
            "-f", "mjpeg", "-i", "pipe:0",
            "-vf", vf,
            "-c:v", "h264_v4l2m2m", "-b:v", String(BITRATE), "-g", String(GOP),
            "-f", "h264", "pipe:1",
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
            if (slices.length > 0) void writer.writeGop(nals, t, slices.length, acts);
            eSum += performance.now() - t0; eCount++;
            resolve();
        });
        enc.on("error", () => resolve());
        enc.stdin?.on("error", () => { /* */ });
        for (const f of frames) { try { enc.stdin?.write(f.jpeg); } catch { /* */ } }
        try { enc.stdin?.end(); } catch { /* */ }
    });
}

function start(): void {
    console.log(`[capture] starting ffmpeg activity-gated pipeline ${WIDTH}x${HEIGHT}@${FPS} (font=${HAVE_FONT})`);
    awaitingGray.length = 0; curGop = []; grayPending = Buffer.alloc(0);

    capProc = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-f", "v4l2", "-input_format", "mjpeg", "-framerate", String(FPS), "-video_size", `${WIDTH}x${HEIGHT}`,
        "-i", VIDEO_DEVICE, "-c", "copy", "-f", "mjpeg", "pipe:1",
    ], { stdio: ["ignore", "pipe", "inherit"] });

    grayProc = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-lowres", "3", "-f", "mjpeg", "-i", "pipe:0",
        "-vf", `scale=${GW}:${GH}`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
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

    let restarted = false;
    const onExit = (who: string) => (code: number | null, signal: string | null) => {
        if (restarted) return; restarted = true;
        console.error(`[capture] ${who} exited code=${code} signal=${signal}; restarting in 2s`);
        try { capProc?.kill("SIGKILL"); } catch { /* */ }
        try { grayProc?.kill("SIGKILL"); } catch { /* */ }
        capProc = grayProc = undefined;
        setTimeout(start, 2000);
    };
    capProc.on("exit", onExit("capture"));
    grayProc.on("exit", onExit("gray-decode"));
    capProc.on("error", e => console.error("[capture] cap spawn error:", e.message));
    grayProc.on("error", e => console.error("[capture] gray spawn error:", e.message));
}

// Stats every 5s: fps (15s sliding), CPU of the two persistent ffmpegs, stage timings.
const FPS_WINDOW_MS = 15_000;
const fpsHist: { ms: number; frames: number }[] = [];
setInterval(async () => {
    try {
        const now = Date.now();
        fpsHist.push({ ms: now, frames: framesWritten });
        while (fpsHist.length > 2 && now - fpsHist[0].ms > FPS_WINDOW_MS) fpsHist.shift();
        const dt = (now - fpsHist[0].ms) / 1000;
        const fps = dt > 0 ? (framesWritten - fpsHist[0].frames) / dt : 0;
        const cpuPct = Math.round((capSampler ? await capSampler.sample() : 0) + (graySampler ? await graySampler.sample() : 0));
        const jpegDecodeMs = dCount ? dSum / dCount : 0, activityMs = aCount ? aSum / aCount : 0, encodeMs = eCount ? eSum / eCount : 0;
        dSum = dCount = aSum = aCount = eSum = eCount = 0;
        await writeEncoderStats({ fps: Math.round(fps * 10) / 10, cpuPct, updatedMs: now, jpegDecodeMs, activityMs, encodeMs });
    } catch (e) { console.error("[capture] stats failed:", (e as Error).message); }
}, 5000);

setInterval(async () => {
    try { const r = await enforceRetention(); if (r.deleted.length) console.log(`[capture] retention: deleted ${r.deleted.length} pair(s), now ${(r.totalBytes / 1e9).toFixed(2)} GB`); }
    catch (e) { console.error("[capture] retention failed:", (e as Error).message); }
}, 60_000);

start();
