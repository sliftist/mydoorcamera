// Client-side activity-region detection over the per-GOP index (state.index).
// A region is a maximal run of consecutive active GOPs (aMax >= threshold). The endpoints
// and peak are then refined to FRAME precision using the per-frame `acts`: startWall = first
// active frame, endWall = end of the last active frame, peakWall = the most-active frame.

import { IndexGop, ACT_SCALE, frameWallOf } from "./indexBuffer";

export type ActivityRegion = {
    startWall: number;    // wall ms — first active frame
    endWall: number;      // wall ms — end of the last active frame
    peakWall: number;     // wall ms — the most-active frame
    peak: IndexGop;       // the most-active GOP in the region (for the thumbnail)
    frameCount: number;   // active frames in the region
    gopCount: number;     // GOPs spanned
    startIdx: number;     // index into `gops` (virtualization / debugging)
};

export function computeRegions(gops: IndexGop[] | null, threshold: number, vs: number, ve: number): ActivityRegion[] {
    if (!gops || !gops.length) return [];
    const u16 = threshold * ACT_SCALE;
    const out: ActivityRegion[] = [];
    let start = -1, peakG: IndexGop | null = null;

    const flush = (endIdx: number) => {
        if (start < 0) return;
        let startWall = Infinity, endWall = -Infinity, peakWall = gops[start].t, peakAct = -1, frames = 0;
        for (let gi = start; gi <= endIdx; gi++) {
            const g = gops[gi];
            const fspan = (g.e - g.t) / Math.max(1, g.acts.length);
            for (let i = 0; i < g.acts.length; i++) {
                if (g.acts[i] < u16) continue;
                const w = frameWallOf(g, i);
                if (w < startWall) startWall = w;
                if (w + fspan > endWall) endWall = w + fspan;
                if (g.acts[i] > peakAct) { peakAct = g.acts[i]; peakWall = w; }
                frames++;
            }
        }
        if (startWall === Infinity) { startWall = gops[start].t; endWall = gops[endIdx].e; peakWall = gops[start].t; }
        out.push({ startWall, endWall, peakWall, peak: peakG!, frameCount: frames, gopCount: endIdx - start + 1, startIdx: start });
        start = -1; peakG = null;
    };

    for (let i = 0; i < gops.length; i++) {
        if (gops[i].aMax >= threshold) {
            if (start < 0) { start = i; peakG = gops[i]; }
            else if (gops[i].aMax > peakG!.aMax) peakG = gops[i];
        } else {
            flush(i - 1);
        }
    }
    flush(gops.length - 1);

    return out.filter(r => r.endWall > vs && r.startWall < ve);
}

// Total GOPs across a set of regions.
export function regionsGopCount(regions: ActivityRegion[]): number {
    let s = 0; for (const r of regions) s += r.gopCount; return s;
}
