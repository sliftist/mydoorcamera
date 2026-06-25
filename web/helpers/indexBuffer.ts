// Parses the raw on-disk index bytes (sent verbatim by getRawIndex) and derives
// what the trackbar needs: coverage ranges, per-GOP activity at any resolution,
// and frame counts. The on-disk framing is [u32 len][f64 fields][u32 len] with
// fields [t, e, o, l, n, a(, aMax)] (see src/storage.ts).

export type IndexGop = { t: number; e: number; n: number; aMax: number };

export function decodeIndex(u8: Uint8Array): IndexGop[] {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out: IndexGop[] = [];
    let p = 0;
    while (p + 4 <= u8.byteLength) {
        const len = dv.getUint32(p, true);
        if (len <= 0 || len % 8 !== 0 || p + 4 + len + 4 > u8.byteLength) break;
        if (dv.getUint32(p + 4 + len, true) !== len) break;
        const k = len / 8;
        const t = dv.getFloat64(p + 4, true);
        const e = dv.getFloat64(p + 12, true);
        const n = dv.getFloat64(p + 36, true);              // field 4
        const a = k > 5 ? dv.getFloat64(p + 44, true) : -1; // field 5
        const aMax = k > 6 ? dv.getFloat64(p + 52, true) : a; // field 6 (thinned avg+max)
        out.push({ t, e, n, aMax });
        p += 4 + len + 4;
    }
    out.sort((x, y) => x.t - y.t);
    return out;
}

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

// Max activity per bucket across [from, to). Each GOP fills the buckets its
// [t, e] footprint spans, so zooming in (smaller window, same bucket count)
// reveals per-GOP detail.
export function bucketActivity(gops: IndexGop[], from: number, to: number, n = 1440): number[] {
    const out = new Array(n).fill(0);
    const span = Math.max(1, to - from);
    for (const g of gops) {
        const act = g.aMax >= 0 ? g.aMax : 0;
        if (act <= 0 || g.e <= from || g.t >= to) continue;
        const i0 = Math.max(0, Math.floor((g.t - from) / span * n));
        const i1 = Math.min(n - 1, Math.floor((g.e - from) / span * n));
        for (let i = i0; i <= i1; i++) if (act > out[i]) out[i] = act;
    }
    return out;
}

// Total frames captured within [from, to).
export function frameCount(gops: IndexGop[], from: number, to: number): number {
    let total = 0;
    for (const g of gops) if (g.e > from && g.t < to) total += g.n;
    return total;
}
