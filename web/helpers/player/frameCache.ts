// Shared decoded-frame cache — the seam that decouples rendering from pre-buffering.
// The pre-buffer (and live feed, and on-miss live decode) all PUT decoded frames here;
// the renderer GETs from here. Frames are kept sorted by footage wall-clock ms.
//
// VideoFrames are GPU-backed and must be closed; eviction and dedup close them.

import { Decoded } from "./types";

export class FrameCache {
    private frames: Decoded[] = []; // sorted ascending by wall

    constructor(private maxFrames: number) {}

    get size(): number { return this.frames.length; }

    // Insert decoded frames (deduped by wall — a re-decoded GOP won't double up).
    putFrames(items: Decoded[]): void {
        for (const d of items) this.insert(d);
        this.enforceMax();
    }
    private insert(d: Decoded): void {
        let i = this.frames.length;
        while (i > 0 && this.frames[i - 1].wall > d.wall) i--;
        const prev = this.frames[i - 1], next = this.frames[i];
        if ((prev && Math.abs(prev.wall - d.wall) < 1) || (next && Math.abs(next.wall - d.wall) < 1)) {
            try { d.frame.close(); } catch { /* */ } // already have this frame
            return;
        }
        this.frames.splice(i, 0, d);
    }

    // The frame to display at `wall`: the latest one at or before it.
    getAtOrBefore(wall: number): Decoded | undefined {
        let best: Decoded | undefined;
        for (const d of this.frames) { if (d.wall <= wall) best = d; else break; }
        return best;
    }
    // The frame is "on time" for `wall` if the latest <= wall is within `tol`.
    getExact(wall: number, tol: number): Decoded | undefined {
        const b = this.getAtOrBefore(wall);
        return b && (wall - b.wall) <= tol ? b : undefined;
    }
    has(wall: number, tol: number): boolean { return !!this.getExact(wall, tol); }
    newest(): Decoded | undefined { return this.frames[this.frames.length - 1]; }

    // Drop (and close) frames strictly older than the current one at `wall`.
    evictBehind(wall: number): void {
        while (this.frames.length >= 2 && this.frames[1].wall <= wall) {
            const d = this.frames.shift()!; try { d.frame.close(); } catch { /* */ }
        }
    }
    // Memory safety: if we somehow exceed the cap, drop the FARTHEST-ahead frames
    // (re-decodable later) rather than the current/near ones.
    private enforceMax(): void {
        while (this.frames.length > this.maxFrames) { const d = this.frames.pop()!; try { d.frame.close(); } catch { /* */ } }
    }

    clear(): void { for (const d of this.frames) { try { d.frame.close(); } catch { /* */ } } this.frames = []; }
}
