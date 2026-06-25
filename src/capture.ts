// Capture daemon: runs the hardware H.264 pipeline, parses the Annex-B byte
// stream into NALs, groups them into self-contained GOPs, and writes them to the
// store. Separate process from the server. Run: yarn typenode ./src/capture.ts

import { spawn } from "child_process";
import { VIDEO_DEVICE, WIDTH, HEIGHT, FPS, BITRATE, GOP } from "./config";
import { AnnexBSplitter, nalType } from "./annexb";
import { StorageWriter, enforceRetention } from "./storage";
import { ProcCpuSampler, writeEncoderStats } from "./stats";
import { getTimezone } from "./timezone";

// Set the timezone before any Date use or spawning gst, so the on-disk date
// folders and the burned-in clock overlay both render local time in our zone.
process.env.TZ = getTimezone();

// FPS-tuned 1080p30 pipeline (see capture-pipeline tuning notes). queue elements
// + videoconvert n-threads=4 spread software JPEG-decode across the 4 cores so we
// sustain ~30fps; v4l2h264enc does the H.264 encode in hardware. Output is raw
// Annex-B on stdout, which we parse ourselves.
function pipelineArgs(): string[] {
    return [
        "-q",
        "v4l2src", `device=${VIDEO_DEVICE}`, "!",
        `image/jpeg,width=${WIDTH},height=${HEIGHT},framerate=${FPS}/1`, "!",
        "queue", "!", "jpegdec", "!",
        "queue", "!", "videoconvert", "n-threads=4", "!",
        `video/x-raw,format=I420,width=${WIDTH},height=${HEIGHT}`, "!",
        "clockoverlay", "time-format=%Y-%m-%d %H:%M:%S %Z", "font-desc=Sans Bold 18", "!",
        "queue", "!",
        "v4l2h264enc", `extra-controls=encode,video_bitrate=${BITRATE},h264_i_frame_period=${GOP}`, "!",
        "video/x-h264,level=(string)4,profile=main", "!",
        "h264parse", "config-interval=1", "!",
        "video/x-h264,stream-format=byte-stream,alignment=au", "!",
        "fdsink", "fd=1",
    ];
}

const writer = new StorageWriter();
const splitter = new AnnexBSplitter();
let framesWritten = 0;
let gstSampler: ProcCpuSampler | undefined;

// Current GOP assembly state.
let sps: Buffer | undefined;
let pps: Buffer | undefined;
let gopNals: Buffer[] = [];
let gopFrames = 0;
let gopTime = 0;

function finalizeGop(): void {
    if (gopFrames > 0 && gopNals.length) {
        try { writer.writeGop(gopNals, gopTime, gopFrames); framesWritten += gopFrames; }
        catch (e) { console.error("writeGop failed:", (e as Error).message); }
    }
    gopNals = [];
    gopFrames = 0;
}

function onNal(nal: Buffer): void {
    if (!nal.length) return;
    const t = nalType(nal);
    if (t === "sps") { sps = nal; return; }
    if (t === "pps") { pps = nal; return; }
    if (t === "idr") {
        finalizeGop();                       // close out the previous GOP
        gopTime = Date.now();
        gopNals = [];
        if (sps) gopNals.push(sps);
        if (pps) gopNals.push(pps);
        gopNals.push(nal);
        gopFrames = 1;
        return;
    }
    if (t === "nonidr") {
        if (gopFrames === 0) return;         // haven't seen the first keyframe yet
        gopNals.push(nal);
        gopFrames++;
        return;
    }
    // drop AUD / SEI / other
}

function start(): void {
    console.log(`[capture] starting pipeline ${WIDTH}x${HEIGHT}@${FPS} bitrate=${BITRATE} gop=${GOP}`);
    const gst = spawn("gst-launch-1.0", pipelineArgs(), { stdio: ["ignore", "pipe", "inherit"] });
    if (gst.pid) gstSampler = new ProcCpuSampler(gst.pid);

    gst.stdout.on("data", (chunk: Buffer) => {
        for (const nal of splitter.push(chunk)) onNal(nal);
    });
    gst.on("exit", (code, signal) => {
        for (const nal of splitter.flush()) onNal(nal);
        finalizeGop();
        console.error(`[capture] gst exited code=${code} signal=${signal}; restarting in 2s`);
        setTimeout(start, 2000);             // self-heal (systemd also restarts the whole daemon)
    });
    gst.on("error", (e) => console.error("[capture] spawn error:", e.message));
}

// Sample encoder throughput + CPU every 5s and publish for the server to read.
let lastFrames = 0, lastStatsMs = Date.now();
setInterval(() => {
    const now = Date.now();
    const dt = (now - lastStatsMs) / 1000;
    const fps = dt > 0 ? (framesWritten - lastFrames) / dt : 0;
    lastFrames = framesWritten; lastStatsMs = now;
    writeEncoderStats({ fps: Math.round(fps * 10) / 10, cpuPct: gstSampler ? Math.round(gstSampler.sample()) : 0, updatedMs: now });
}, 5000);

// Enforce the rolling byte cap every 60s.
setInterval(() => {
    try {
        const r = enforceRetention();
        if (r.deletedHours.length) {
            console.log(`[capture] retention: deleted ${r.deletedHours.length} hour(s), now ${(r.totalBytes / 1e9).toFixed(2)} GB`);
        }
    } catch (e) { console.error("[capture] retention failed:", (e as Error).message); }
}, 60_000);

start();
