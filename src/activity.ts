// Activity worker (separate daemon — keeps the critical capture path untouched).
// Backfills each GOP's `activity` float. For each sampled keyframe it measures how
// much the frame differs from a ROBUST steady-state background, then keeps only
// changes that are both strong AND spatially clustered:
//   1. decode the keyframe to a small grayscale image;
//   2. background = per-pixel MEDIAN over a ring of recent good frames. A median is
//      robust: a moving object, a rolling brightness band, or a brief video dropout
//      are outliers that don't move it, so they don't get "learned" or cause spikes;
//   3. deviation from background, minus the global brightness shift (so whole-frame
//      auto-exposure doesn't register);
//   4. MAGNITUDE GATE: a pixel must change by more than `STRONG` levels to be a
//      candidate (a subtle rolling bar changes too little to qualify);
//   5. DENSITY / REGION: candidates only count where they are locally dense (a real
//      object forms a compact region; scattered sensor noise does not);
//   6. activity = fraction of the frame covered by such regions (small object =
//      small, big object = large).
// Corrupt/blank frames (video dropout) are skipped entirely — not measured, not
// added to the background. Throttled so it never starves the live encoder.

import { spawn } from "child_process";
import { getTimezone } from "./timezone";
process.env.TZ = getTimezone();
import { findPendingActivity, writeActivity, readGopBytes, GopEntry } from "./storage";
import { splitFramedNals } from "./annexb";

const W = 256, H = 144, FRAME = W * H;   // grayscale analysis frame
const STRONG = 12;                        // a pixel must differ from background by > this to be a candidate
const DENSITY_R = 2;                      // clustering radius (local strong-pixel density window)
const DENSITY_THR = 0.18;                 // a candidate counts only where >18% of its neighborhood is also strong
const RING = 60;                          // background = per-pixel median over this many recent good frames
const MIN_RING = 20;                      // need at least this many before measuring (warm-up)
const LOWVAR = 50;                        // frame variance below this = blank/corrupt (dropout) -> skip
// Ignore the burned-in timestamp (top-left). At 256x144 the clock text spans roughly
// the top ~11% of rows and ~75% of the width.
const MASK_ROWS = Math.round(0.11 * H), MASK_COLS = Math.round(0.75 * W);
const PENDING_LIMIT = 12;                 // records examined per pass
const PERIOD_MS = 1000;
const SAMPLE_INTERVAL_MS = 500;           // sample ~every keyframe (GOPs are ~1s)
const START_CODE = Buffer.from([0, 0, 0, 1]);

const ring: Buffer[] = [];                // recent good frames (background source); persists across passes
let lastSampledT = -Infinity;

const masked = (i: number): boolean => { const row = (i / W) | 0, col = i % W; return row < MASK_ROWS && col < MASK_COLS; };
const counted = FRAME - MASK_ROWS * MASK_COLS;

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
function frameMean(f: Buffer): number { let s = 0; for (let i = 0; i < FRAME; i++) s += f[i]; return s / FRAME; }
function frameVar(f: Buffer, m: number): number { let s = 0; for (let i = 0; i < FRAME; i++) s += (f[i] - m) * (f[i] - m); return s / FRAME; }

// Per-pixel median background over the ring (robust to outliers: objects, bands, dropouts).
function backgroundMedian(): Float32Array {
    const n = ring.length, bg = new Float32Array(FRAME), col = new Array<number>(n);
    for (let i = 0; i < FRAME; i++) { for (let k = 0; k < n; k++) col[k] = ring[k][i]; col.sort((a, b) => a - b); bg[i] = col[n >> 1]; }
    return bg;
}

function activityOf(cur: Buffer): number {
    const bg = backgroundMedian();
    const s = new Float32Array(FRAME);
    const vals: number[] = [];
    for (let i = 0; i < FRAME; i++) { if (masked(i)) { s[i] = 0; continue; } s[i] = cur[i] - bg[i]; vals.push(s[i]); }
    const shift = medianOf(vals); // global brightness shift (uniform auto-exposure)
    // Magnitude gate: only pixels that changed strongly are candidates.
    const mask = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) mask[i] = (!masked(i) && Math.abs(s[i] - shift) > STRONG) ? 1 : 0;
    // Density: candidates count only where they form a locally-dense region (a real
    // object), not scattered specks. activity = area of those regions.
    const density = boxBlur(mask, DENSITY_R);
    let area = 0;
    for (let i = 0; i < FRAME; i++) { if (masked(i)) continue; if (density[i] > DENSITY_THR) area++; }
    return area / counted;
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
        const f = frames[i];
        let a = 0;
        const v = frameVar(f, frameMean(f));
        if (v >= LOWVAR) {                                  // skip blank/corrupt (dropout) frames
            if (ring.length >= MIN_RING) a = activityOf(f); // else still warming up -> 0
            ring.push(Buffer.from(f));                      // copy (decoded frame is a slice of a shared buffer)
            if (ring.length > RING) ring.shift();
        }
        try { await writeActivity(toSample[i].parts, toSample[i].idxFile, toSample[i].start, a); } catch { /* */ }
    }
    setTimeout(loop, PERIOD_MS);
}

console.log("[activity] worker started");
loop();
