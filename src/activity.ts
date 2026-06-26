// Activity worker (separate daemon — keeps the critical capture path untouched).
// Backfills each GOP's `activity` float. For each sampled keyframe it measures how
// much the frame differs from a learned STEADY-STATE BACKGROUND (not just the prior
// frame), so something that enters the scene and moves only subtly still counts as a
// big change from the base state. Detection is:
//   1. decode the keyframe to a small grayscale image;
//   2. subtract a per-pixel running-median background (transient objects barely move
//      it; slow lighting drift is absorbed within minutes);
//   3. remove the global brightness shift (median of the diff) so whole-frame
//      auto-exposure / rolling bands don't register;
//   4. box-blur the deviation to require SPATIAL COHERENCE — a localized blob (a real
//      object) survives, scattered single-pixel sensor noise averages away;
//   5. activity = fraction of clustered pixels above threshold (so a small distinct
//      object = moderate, a big one = large).
// Throttled so it never starves the live encoder. Run via typenode.

import { spawn } from "child_process";
import { getTimezone } from "./timezone";
process.env.TZ = getTimezone();
import { findPendingActivity, writeActivity, readGopBytes, GopEntry } from "./storage";
import { splitFramedNals } from "./annexb";

const W = 256, H = 144, FRAME = W * H;   // grayscale analysis frame (small but enough to see distant objects)
const CLUSTER_R = 2;                      // box-blur radius: a change must be spatially coherent to count
const CLUSTER_THR = 4;                    // blurred deviation above this (per pixel) counts as changed
const BG_STEP = 1;                        // running-median background adapts +/- this per sample (~1/s)
// Ignore the burned-in timestamp (top-left). At 256x144 the clock text spans roughly
// the top ~11% of rows and ~75% of the width; box covers the changing digits generously.
const MASK_ROWS = Math.round(0.11 * H), MASK_COLS = Math.round(0.75 * W);
const PENDING_LIMIT = 12;                 // records examined per pass
const PERIOD_MS = 1000;
const SAMPLE_INTERVAL_MS = 500;           // sample ~every keyframe (GOPs are ~1s); finer than the old 3s
const START_CODE = Buffer.from([0, 0, 0, 1]);

const bg = new Float32Array(FRAME);       // per-pixel running-median background (persists across passes)
let bgInit = false;
let lastSampledT = -Infinity;

const masked = (i: number): boolean => { const row = (i / W) | 0, col = i % W; return row < MASK_ROWS && col < MASK_COLS; };

// Extract SPS+PPS+IDR of a GOP as an Annex-B access unit.
async function keyframeAU(parts: string[], g: GopEntry): Promise<Buffer> {
    const out: Buffer[] = [];
    for (const n of splitFramedNals(await readGopBytes(parts, g.f, g.o, g.l))) {
        const t = n[0] & 0x1f;
        if (t === 7 || t === 8 || t === 5) { out.push(START_CODE, n); }
    }
    return Buffer.concat(out);
}

// Software-decode (avdec_h264) a concatenated keyframe stream to GRAY8 WxH frames.
// Software (CPU) is used deliberately: the hardware decoder shares the bcm2835 codec
// block with the live encoder and dropped it 30->24fps, whereas CPU decode runs on
// spare cores and leaves the encoder at 30.
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

function medianOf(a: number[]): number { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }

// Background-subtraction activity, then adapt the background toward the current frame.
function activityOf(cur: Buffer): number {
    if (!bgInit) { for (let i = 0; i < FRAME; i++) bg[i] = cur[i]; bgInit = true; return 0; }
    // Signed deviation from the steady-state background (timestamp area zeroed).
    const s = new Float32Array(FRAME);
    const vals: number[] = [];
    for (let i = 0; i < FRAME; i++) { if (masked(i)) { s[i] = 0; continue; } s[i] = cur[i] - bg[i]; vals.push(s[i]); }
    // Remove the global brightness shift (uniform auto-exposure / rolling band).
    const shift = medianOf(vals);
    const d = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) d[i] = masked(i) ? 0 : Math.abs(s[i] - shift);
    // Require spatial coherence: a localized blob survives, isolated noise averages away.
    const blur = boxBlur(d, CLUSTER_R);
    let changed = 0, counted = 0;
    for (let i = 0; i < FRAME; i++) { if (masked(i)) continue; counted++; if (blur[i] > CLUSTER_THR) changed++; }
    // Running-median (sigma-delta) background update: nudge each pixel toward `cur`.
    for (let i = 0; i < FRAME; i++) { if (cur[i] > bg[i]) bg[i] += BG_STEP; else if (cur[i] < bg[i]) bg[i] -= BG_STEP; }
    return counted ? changed / counted : 0;
}

async function loop(): Promise<void> {
    type Pending = Awaited<ReturnType<typeof findPendingActivity>>;
    let pending: Pending = [];
    try { pending = await findPendingActivity(PENDING_LIMIT); } catch { /* */ }
    if (!pending.length) { setTimeout(loop, PERIOD_MS); return; }

    // Sample ~every keyframe; any GOPs closer than SAMPLE_INTERVAL_MS get 0.
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
        const a = activityOf(frames[i]);
        try { await writeActivity(toSample[i].parts, toSample[i].idxFile, toSample[i].start, a); } catch { /* */ }
    }
    setTimeout(loop, PERIOD_MS);
}

console.log("[activity] worker started");
loop();
