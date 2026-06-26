// Activity worker (separate daemon — keeps the critical capture path untouched).
// Backfills each GOP's `activity` float: hardware-decodes the keyframe to a tiny
// grayscale frame and measures the fraction of pixels that changed (beyond a
// noise floor) vs the previous keyframe. Throttled so it never starves the live
// encoder. Run via typenode.

import { spawn } from "child_process";
import { getTimezone } from "./timezone";
process.env.TZ = getTimezone();
import { findPendingActivity, writeActivity, readGopBytes, GopEntry } from "./storage";
import { splitFramedNals } from "./annexb";

const W = 64, H = 36, FRAME = W * H;   // tiny grayscale frame
const NOISE = 16;                       // per-pixel change below this is treated as sensor noise
const LOCAL_R = 4;                      // high-pass radius: subtract the local-mean diff so smooth
                                        // (global/rolling-band) brightness changes don't count, only
                                        // localized/textured changes do
// Ignore the burned-in timestamp (top-left) so its ticking digits aren't read as
// activity. The clock text spans ~cols 0-40 of the 64-wide frame; box covers it
// generously (the changing time digits measured out to col ~39).
const MASK_ROWS = 4, MASK_COLS = 48;
const PENDING_LIMIT = 12;               // records examined per pass
const PERIOD_MS = 1000;
const SAMPLE_INTERVAL_MS = 3000;        // only decode/diff one keyframe every ~3s (the rest get 0)
const START_CODE = Buffer.from([0, 0, 0, 1]);

let prevFrame: Buffer | undefined;
let lastSampledT = -Infinity;

// Extract SPS+PPS+IDR of a GOP as an Annex-B access unit.
async function keyframeAU(parts: string[], g: GopEntry): Promise<Buffer> {
    const out: Buffer[] = [];
    for (const n of splitFramedNals(await readGopBytes(parts, g.f, g.o, g.l))) {
        const t = n[0] & 0x1f;
        if (t === 7 || t === 8 || t === 5) { out.push(START_CODE, n); }
    }
    return Buffer.concat(out);
}

// Software-decode (avdec_h264) a concatenated keyframe stream to GRAY8 WxH
// frames. Software (CPU) is used deliberately: the hardware decoder shares the
// bcm2835 codec block with the live encoder and dropped it 30->24fps, whereas
// CPU decode (~35ms/keyframe) runs on spare cores and leaves the encoder at 30.
function decode(stream: Buffer): Promise<Buffer[]> {
    return new Promise(resolve => {
        const gst = spawn("gst-launch-1.0", [
            "-q", "fdsrc", "fd=0", "!", "h264parse", "!", "avdec_h264", "!",
            "videoconvert", "!", "videoscale", "!", `video/x-raw,format=GRAY8,width=${W},height=${H}`, "!",
            "fdsink", "fd=1",
        ], { stdio: ["pipe", "pipe", "ignore"] });
        const chunks: Buffer[] = [];
        gst.stdout.on("data", (c: Buffer) => chunks.push(c));
        gst.on("close", () => {
            const all = Buffer.concat(chunks);
            const frames: Buffer[] = [];
            for (let i = 0; i + FRAME <= all.length; i += FRAME) frames.push(all.subarray(i, i + FRAME));
            resolve(frames);
        });
        gst.on("error", () => resolve([]));
        gst.stdin.on("error", () => { /* ignore EPIPE if decoder died */ });
        gst.stdin.write(stream);
        gst.stdin.end();
    });
}

// Separable box blur of a WxH float field (local mean over a (2R+1)^2 window).
function boxBlur(src: Float32Array, r: number): Float32Array {
    const tmp = new Float32Array(FRAME), out = new Float32Array(FRAME);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s = 0, c = 0;
        for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx >= 0 && xx < W) { s += src[y * W + xx]; c++; } }
        tmp[y * W + x] = s / c;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s = 0, c = 0;
        for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]; c++; } }
        out[y * W + x] = s / c;
    }
    return out;
}

function activityOf(cur: Buffer, prev?: Buffer): number {
    if (!prev) return 0;
    // Frame difference, with the timestamp area zeroed.
    const diff = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
        const row = (i / W) | 0, col = i % W;
        diff[i] = (row < MASK_ROWS && col < MASK_COLS) ? 0 : cur[i] - prev[i];
    }
    // High-pass: subtract the local mean so smooth brightness changes (global
    // auto-exposure, rolling bands) cancel; localized/textured motion remains.
    const local = boxBlur(diff, LOCAL_R);
    let changed = 0, counted = 0;
    for (let i = 0; i < FRAME; i++) {
        const row = (i / W) | 0, col = i % W;
        if (row < MASK_ROWS && col < MASK_COLS) continue; // skip the timestamp area
        counted++;
        if (Math.abs(diff[i] - local[i]) > NOISE) changed++;
    }
    return counted ? changed / counted : 0;
}

async function loop(): Promise<void> {
    type Pending = Awaited<ReturnType<typeof findPendingActivity>>;
    let pending: Pending = [];
    try { pending = await findPendingActivity(PENDING_LIMIT); } catch { /* */ }
    if (!pending.length) { setTimeout(loop, PERIOD_MS); return; }

    // Sample at most one keyframe per SAMPLE_INTERVAL_MS; the skipped GOPs in
    // between are written 0 (the per-minute max chart only needs occasional samples).
    const toSample: Pending = [];
    for (const p of pending) {
        if (p.gop.t - lastSampledT >= SAMPLE_INTERVAL_MS) { toSample.push(p); lastSampledT = p.gop.t; }
        else { try { await writeActivity(p.parts, p.idxFile, p.start, 0); } catch { /* */ } }
    }
    if (!toSample.length) { setTimeout(loop, PERIOD_MS); return; }

    let frames: Buffer[] = [];
    try { frames = await decode(Buffer.concat(await Promise.all(toSample.map(p => keyframeAU(p.parts, p.gop))))); }
    catch { /* */ }
    if (frames.length === 0) {
        try { await writeActivity(toSample[0].parts, toSample[0].idxFile, toSample[0].start, 0); } catch { /* */ }
        setTimeout(loop, PERIOD_MS); return;
    }
    const k = Math.min(frames.length, toSample.length);
    for (let i = 0; i < k; i++) {
        const a = activityOf(frames[i], prevFrame);
        prevFrame = frames[i];
        try { await writeActivity(toSample[i].parts, toSample[i].idxFile, toSample[i].start, a); } catch { /* */ }
    }
    setTimeout(loop, PERIOD_MS);
}

console.log("[activity] worker started");
loop();
