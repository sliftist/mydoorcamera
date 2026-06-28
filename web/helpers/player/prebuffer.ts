// PRE-RENDER (best-effort). Walks GOPs ahead of the playhead and (a) decodes the nearest
// few into the shared FrameCache so the renderer finds them instantly, and (b) prefetches
// raw bytes further ahead (cheap) so live decodes are fast. It is purely additive: every
// call is deduped/idempotent (ensureGop + getBytes dedupe internally), it swallows all
// errors, and a re-entry guard keeps one pass at a time. If it does nothing, playback
// still works — the renderer decodes on demand and the clock skips if it can't keep up.

import { GopEntry } from "./types";
import { GopSource } from "./gopSource";
import { GopDecoder } from "./gopDecoder";
import { FrameCache } from "./frameCache";

const DECODE_AHEAD_SEC = 4;     // decode this much playback ahead (also bounded by cache room)
const BYTES_AHEAD_SEC = 10;     // prefetch raw bytes this much playback ahead
const GOP_LOOKAHEAD = 24;       // GOPs to consider per pass
const DECODE_BATCH = 8;         // max GOPs to decode per pass
const FRAME_CACHE_SOFT = 180;   // stop decoding ahead when the cache is this full

export class Prebuffer {
    private busy = false;

    constructor(private source: GopSource, private decoder: GopDecoder, private cache: FrameCache) {}

    pump(playWall: number, speed: number): void {
        if (this.busy) return;
        this.busy = true;
        void this.run(playWall, Math.max(1, speed)).finally(() => { this.busy = false; });
    }

    private async run(playWall: number, speed: number): Promise<void> {
        const decHorizon = playWall + DECODE_AHEAD_SEC * 1000 * this.source.comp * speed;
        const byteHorizon = playWall + BYTES_AHEAD_SEC * 1000 * this.source.comp * speed;
        let gops: GopEntry[] = [];
        try { gops = await this.source.gopsFrom(playWall, GOP_LOOKAHEAD); }
        catch { return; }
        // (a) decode the nearest GOPs (bounded by cache room + decode horizon)
        let decoded = 0;
        for (const g of gops) {
            if (g.t > decHorizon) break;
            if (this.cache.size >= FRAME_CACHE_SOFT) break;
            if (decoded >= DECODE_BATCH) break;
            try { await this.decoder.ensureGop(g, false); } catch { /* best-effort */ }
            decoded++;
        }
        // (b) prefetch raw bytes further ahead (cheap; fills the byte cache)
        for (const g of gops) {
            if (g.t > byteHorizon) break;
            if (this.source.hasBytes(g)) continue;
            void this.source.getBytes(g, false).catch(() => { /* */ });
        }
    }
}
