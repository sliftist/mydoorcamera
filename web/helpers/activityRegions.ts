// Client-side activity-region detection over the per-GOP index (state.index).
// A "region" is a maximal run of CONSECUTIVE active GOPs (aMax >= threshold) — nothing
// more. No lead-in, no tail, no gap bridging: a single inactive GOP ends the region, and
// adjacent active GOPs belong to the same region. The region is tight around the activity:
// it spans from the first active GOP's start to the last active GOP's end.

import { IndexGop } from "./indexBuffer";

export type ActivityRegion = {
    start: number;        // wall ms — start of the first active GOP
    end: number;          // wall ms — end of the last active GOP
    peak: IndexGop;       // the most-active GOP in the region (its peak frame is the thumbnail)
    gopCount: number;     // active GOPs in the region
    startIdx: number;     // index into `gops` of the region start (for virtualization / debugging)
};

// Detect regions across the whole index, then keep only those overlapping [vs, ve]
// (so zooming the trackbar in shows fewer regions). `gops` must be sorted by t.
export function computeRegions(gops: IndexGop[] | null, threshold: number, vs: number, ve: number): ActivityRegion[] {
    if (!gops || !gops.length) return [];
    const out: ActivityRegion[] = [];
    let start = -1, peak: IndexGop | null = null, count = 0;

    const flush = (endIdx: number) => {
        if (start < 0) return;
        out.push({ start: gops[start].t, end: gops[endIdx].e, peak: peak!, gopCount: count, startIdx: start });
        start = -1; peak = null; count = 0;
    };

    for (let i = 0; i < gops.length; i++) {
        if (gops[i].aMax >= threshold) {
            if (start < 0) { start = i; peak = gops[i]; count = 0; }
            else if (gops[i].aMax > peak!.aMax) peak = gops[i];
            count++;
        } else {
            flush(i - 1); // the run ended at the previous GOP
        }
    }
    flush(gops.length - 1);

    return out.filter(r => r.end > vs && r.start < ve);
}

// Total GOPs across a set of regions.
export function regionsGopCount(regions: ActivityRegion[]): number {
    let s = 0; for (const r of regions) s += r.gopCount; return s;
}
