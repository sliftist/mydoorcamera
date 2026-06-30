// Parses the raw on-disk index bytes (sent verbatim by getRawIndex) and derives
// what the trackbar needs: coverage ranges, per-GOP activity at any resolution,
// and frame counts. The on-disk framing is [u32 len][f64 fields][u32 len] with
// fields [t, e, o, l, n, a(, aMax)] (see src/storage.ts).

// Per-frame activity (uint16 = act*65535) for each of the GOP's n frames; aMax is the derived
// max. noChange (l === 0) = a static GOP with no video bytes; `ref` (the o field) is the start
// time of the GOP whose last frame it repeats.
export const ACT_SCALE = 65535;
export type IndexGop = { t: number; e: number; n: number; acts: Uint16Array; aMax: number; noChange: boolean; ref: number };

// Record: [u32 len][f64 t,e,o,l,n][u16 acts...][u32 len], len = 40 + 2*n. (see src/storage.ts)
export function decodeIndex(u8: Uint8Array): IndexGop[] {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out: IndexGop[] = [];
    let p = 0;
    while (p + 4 <= u8.byteLength) {
        const len = dv.getUint32(p, true);
        if (len < 40 || (len - 40) % 2 !== 0 || p + 4 + len + 4 > u8.byteLength) break;
        if (dv.getUint32(p + 4 + len, true) !== len) break;
        const t = dv.getFloat64(p + 4, true);
        const e = dv.getFloat64(p + 12, true);
        const o = dv.getFloat64(p + 20, true); // offset, or refT when no-change
        const l = dv.getFloat64(p + 28, true); // length; 0 => no-change
        const n = dv.getFloat64(p + 36, true);
        const na = (len - 40) / 2;
        const acts = new Uint16Array(na);
        let mx = 0;
        for (let i = 0; i < na; i++) { const v = dv.getUint16(p + 44 + i * 2, true); acts[i] = v; if (v > mx) mx = v; }
        const noChange = l === 0;
        out.push({ t, e, n, acts, aMax: mx / ACT_SCALE, noChange, ref: noChange ? o : 0 });
        p += 4 + len + 4;
    }
    out.sort((x, y) => x.t - y.t);
    return out;
}

// Per-frame wall time of frame i within a GOP (frames spread evenly across [t, e]).
export function frameWallOf(g: IndexGop, i: number): number {
    const span = g.e - g.t;
    const n = Math.max(1, g.acts.length || g.n);
    return g.t + (span * i) / n;
}
// Activity (0..1) of frame i.
export function frameAct(g: IndexGop, i: number): number { return (g.acts[i] || 0) / ACT_SCALE; }

// Merge GOP footprints into contiguous coverage ranges (joining small gaps).
export function deriveRanges(gops: IndexGop[], joinMs: number): { start: number; end: number }[] {
    if (!gops.length) return [];
    const out = [{ start: gops[0].t, end: gops[0].e }];
    for (let i = 1; i < gops.length; i++) {
        const last = out[out.length - 1];
        if (gops[i].t <= last.end + joinMs) last.end = Math.max(last.end, gops[i].e);
        else out.push({ start: gops[i].t, end: gops[i].e });
    }
    return out;
}

// Max activity per bucket across [from, to), using PER-FRAME activity so events shorter than
// a GOP show. Each frame contributes its activity to the bucket its wall time lands in. Buckets
// with NO frame stay -1 ("no data") rather than 0 — when zoomed in past the frame rate the curve
// should connect actual samples, not stab down to zero between them (there's just no poll there).
// Frames with zero activity DO count (they're real data: activity 0), so static spans read as 0.
export function bucketActivity(gops: IndexGop[], from: number, to: number, n = 1440): number[] {
    const out = new Array(n).fill(-1);
    const span = Math.max(1, to - from);
    for (const g of gops) {
        if (g.e <= from || g.t >= to || !g.acts.length) continue;
        for (let i = 0; i < g.acts.length; i++) {
            const w = frameWallOf(g, i);
            if (w < from || w >= to) continue;
            const a = g.acts[i] / ACT_SCALE;
            const b = Math.min(n - 1, Math.max(0, Math.floor((w - from) / span * n)));
            if (a > out[b]) out[b] = a; // out[b] starts at -1, so any frame (even a=0) marks it as data
        }
    }
    return out;
}

// Total frames captured within [from, to).
export function frameCount(gops: IndexGop[], from: number, to: number): number {
    let total = 0;
    for (const g of gops) if (g.e > from && g.t < to) total += g.n;
    return total;
}
