// Activity detector (shared). Measures how much a grayscale frame differs from a ROBUST
// steady-state background, keeping only changes that are both strong AND spatially clustered:
//   1. background = per-pixel MEDIAN over a ring of recent good frames (robust to moving
//      objects, rolling brightness bands, and brief dropouts — they're outliers);
//   2. deviation minus the global brightness shift (so auto-exposure doesn't register);
//   3. MAGNITUDE GATE: a pixel must change by > STRONG levels to be a candidate;
//   4. DENSITY: candidates count only where locally dense (a real object forms a region);
//   5. activity = fraction of the frame covered by such regions.
// Blank/corrupt frames (variance < LOWVAR) are skipped — not measured, not learned.
//
// `ActivityModel` holds the background ring; feed it the live GRAY8 frames in order.

export const W = 120, H = 68, FRAME = W * H;    // small grayscale analysis frame (cheap per-frame activity)
const STRONG = 12;        // a pixel must differ from background by > this to be a candidate
const DENSITY_R = 2;      // clustering radius (local strong-pixel density window)
const DENSITY_THR = 0.18; // a candidate counts only where >18% of its neighborhood is also strong
const RING = 60;          // background = per-pixel median over this many recent good frames
const MIN_RING = 20;      // need at least this many before measuring (warm-up)
const LOWVAR = 50;        // frame variance below this = blank/corrupt (dropout) -> skip
// Ignore the burned-in timestamp (top-left). At 256x144 the clock spans ~top 11% rows, ~75% cols.
const MASK_ROWS = Math.round(0.11 * H), MASK_COLS = Math.round(0.75 * W);

const masked = (i: number): boolean => { const row = (i / W) | 0, col = i % W; return row < MASK_ROWS && col < MASK_COLS; };
const COUNTED = FRAME - MASK_ROWS * MASK_COLS;

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

const BG_EVERY = 15; // recompute the (expensive) median background every N frames, not every frame

export class ActivityModel {
    private ring: Buffer[] = []; // recent good frames (background source)
    private bg: Float32Array | null = null; // cached median background
    private since = 0;           // frames until the next background refresh

    // Per-pixel median background over the ring.
    private backgroundMedian(): Float32Array {
        const n = this.ring.length, bg = new Float32Array(FRAME), col = new Array<number>(n);
        for (let i = 0; i < FRAME; i++) { for (let k = 0; k < n; k++) col[k] = this.ring[k][i]; col.sort((a, b) => a - b); bg[i] = col[n >> 1]; }
        return bg;
    }

    // Cheap per-frame measure against the CACHED background (diff + gate + density).
    private activityOf(cur: Buffer, bg: Float32Array): number {
        const s = new Float32Array(FRAME);
        const vals: number[] = [];
        for (let i = 0; i < FRAME; i++) { if (masked(i)) { s[i] = 0; continue; } s[i] = cur[i] - bg[i]; vals.push(s[i]); }
        const shift = medianOf(vals); // global brightness shift (uniform auto-exposure)
        const mask = new Float32Array(FRAME);
        for (let i = 0; i < FRAME; i++) mask[i] = (!masked(i) && Math.abs(s[i] - shift) > STRONG) ? 1 : 0;
        const density = boxBlur(mask, DENSITY_R);
        let area = 0;
        for (let i = 0; i < FRAME; i++) { if (masked(i)) continue; if (density[i] > DENSITY_THR) area++; }
        return area / COUNTED;
    }

    // Measure one GRAY8 frame (length FRAME). The median background is refreshed only every
    // BG_EVERY frames (it changes slowly), so the per-frame cost is just the cheap diff.
    compute(gray: Buffer): number {
        const v = frameVar(gray, frameMean(gray));
        if (v < LOWVAR) return 0; // blank/corrupt -> skip (don't measure, don't learn)
        if (this.since <= 0 || !this.bg) {
            this.ring.push(Buffer.from(gray)); // copy: the input may be a slice of a shared buffer
            if (this.ring.length > RING) this.ring.shift();
            if (this.ring.length >= MIN_RING) this.bg = this.backgroundMedian();
            this.since = BG_EVERY;
        }
        this.since--;
        return this.bg ? this.activityOf(gray, this.bg) : 0;
    }
}
