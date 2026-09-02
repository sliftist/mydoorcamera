// PREFETCH (best-effort). Walks GOPs ahead of the playhead and warms the raw-bytes cache,
// so when frameStream's feed plan reaches them it never waits on the network. Decode-ahead
// itself lives in frameStream's look-ahead window — this fetches bytes only. Purely
// additive: getBytes dedupes internally, errors are swallowed, and a re-entry guard keeps
// one pass at a time. If it does nothing, playback still works (just with network waits).

import { GopEntry } from "./types";
import { GopSource } from "./gopSource";

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
        for (const g of gops) {
            if (this.source.isNoChange(g)) continue; // static span: no bytes to fetch
            if (!this.source.hasBytes(g)) void this.source.getBytes(g, false).catch(() => { /* */ });
        }
    }
}
