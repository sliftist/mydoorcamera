// PRE-RENDER (best-effort). Walks GOPs ahead of the playhead and asks the cache to decode
// the nearest few (so the renderer finds them instantly) and to prefetch raw bytes further
// ahead (cheap). Purely additive: everything is deduped by the cache/source, errors are
// swallowed, and a re-entry guard keeps one pass at a time. If it does nothing, playback
// still works — the cache decodes on demand and the clock skips if it can't keep up.

import { GopEntry } from "./types";
import { GopSource } from "./gopSource";
import { FrameCache } from "./frameCache";

const DECODE_AHEAD_GOPS = 2;   // decode this many GOPs ahead (whole-GOP -> keep this small)
const BYTES_AHEAD_GOPS = 12;   // prefetch raw bytes this many GOPs ahead

export class Prebuffer {
    private busy = false;

    constructor(private source: GopSource, private cache: FrameCache) {}

    pump(playWall: number): void {
        if (this.busy) return;
        this.busy = true;
        void this.run(playWall).finally(() => { this.busy = false; });
    }

    private async run(playWall: number): Promise<void> {
        let gops: GopEntry[] = [];
        try { gops = await this.source.gopsFrom(playWall, BYTES_AHEAD_GOPS); }
        catch { return; }
        for (let i = 0; i < gops.length; i++) {
            if (i < DECODE_AHEAD_GOPS) { try { await this.cache.ensure(gops[i]); } catch { /* */ } }
            else if (!this.source.hasBytes(gops[i])) void this.source.getBytes(gops[i], false).catch(() => { /* */ });
        }
    }
}
