// Client-side activity-region detection over the per-GOP index (state.index).
// A "region" is a contiguous stretch of footage around activity, defined purely in
// GOP-index-entry counts (NOT wall time), so it's independent of how often the
// activity worker samples: a LEAD-GOP lead-in buffer before the first active GOP,
// the region stays alive across gaps up to GAP GOPs, and a TAIL-GOP trailing buffer.

import { IndexGop } from "./indexBuffer";

export type ActivityRegion = {
    start: number;        // wall ms (region start, incl. lead-in)
    end: number;          // wall ms (region end, incl. tail)
    peak: IndexGop;       // the GOP with the most activity in the region (its keyframe is the thumbnail)
    gopCount: number;     // GOPs covered by the region
    startIdx: number;     // index into `gops` of the region start (for virtualization / debugging)
};

const LEAD = 5;   // GOPs of buffer before the first active GOP
const GAP = 10;   // region stays alive while activity recurs within this many GOPs
const TAIL = 5;   // GOPs of buffer after the last active GOP

// Detect regions across the whole index, then keep only those overlapping [vs, ve]
// (so zooming the trackbar in shows fewer regions). `gops` must be sorted by t.
export function computeRegions(gops: IndexGop[] | null, threshold: number, vs: number, ve: number): ActivityRegion[] {
    if (!gops || !gops.length) return [];
    const n = gops.length;
    const out: ActivityRegion[] = [];
    let firstActive = -1, lastActive = -1, peak: IndexGop | null = null;

    const flush = () => {
        if (firstActive < 0) return;
        const s = Math.max(0, firstActive - LEAD);
        const e = Math.min(n - 1, lastActive + TAIL);
        out.push({ start: gops[s].t, end: gops[e].e, peak: peak!, gopCount: e - s + 1, startIdx: s });
        firstActive = lastActive = -1; peak = null;
    };

    for (let i = 0; i < n; i++) {
        const active = gops[i].aMax >= threshold;
        if (active) {
            if (firstActive < 0) firstActive = i;
            else if (i - lastActive > GAP) { flush(); firstActive = i; } // gap too big -> close, start new
            lastActive = i;
            if (!peak || gops[i].aMax > peak.aMax) peak = gops[i];
        }
    }
    flush();

    return out.filter(r => r.end > vs && r.start < ve);
}

// Total GOPs across a set of regions.
export function regionsGopCount(regions: ActivityRegion[]): number {
    let s = 0; for (const r of regions) s += r.gopCount; return s;
}
