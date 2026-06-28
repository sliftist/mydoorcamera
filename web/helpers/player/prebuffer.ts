// PRE-RENDER (best-effort). Walks GOPs ahead of the playhead and asks the cache to decode
// the nearest few (so the renderer finds them instantly) and to prefetch raw bytes a little
// further ahead. Purely additive — getFrame/getBytes dedupe internally, errors are swallowed,
// and a re-entry guard keeps one pass at a time. If it does nothing, playback still works
// (the clock decodes on demand and skips if it can't keep up).

import { GopEntry } from "./types";
import { GopSource } from "./gopSource";
import { getFrame } from "./frameCache";

const DECODE_AHEAD_GOPS = 3;
const BYTES_AHEAD_GOPS = 12;

export class Prebuffer {
    private busy = false;

    constructor(private source: GopSource) {}

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
            if (i < DECODE_AHEAD_GOPS) {
                try { await getFrame(this.source, gops[i], 0); } catch { /* */ }
            } else if (!this.source.hasBytes(gops[i])) {
                void this.source.getBytes(gops[i], false).catch(() => { /* */ });
            }
        }
    }
}
