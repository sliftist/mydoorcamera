// Generative decoded-frame cache. You ask it for a frame — `get(gop, index)` — and it
// either returns the already-decoded VideoFrame, or (on a miss) kicks off decoding the
// whole GOP and returns undefined for now (a later call gets it). Concurrent requests for
// the same GOP share one decode (deduped by gop.t). This is the only place decoding
// happens; callers just ask for frames.
//
// Whole-GOP decode is required because frames are delta-coded — you can't get frame N
// without decoding 0..N — so the cache holds all of a GOP's frames together and evicts by
// GOP (LRU). VideoFrames are GPU-backed; eviction/clear closes them.

import { GopEntry } from "./types";
import { GopSource } from "./gopSource";
import { accessUnitsFromGop, codecFromSps } from "../h264";

type Entry = { frames: VideoFrame[]; ready: boolean; promise: Promise<void> };

export class FrameCache {
    private gops = new Map<number, Entry>();
    private lru: number[] = []; // gop.t, most-recently-used last

    constructor(private source: GopSource, private maxGops: number) {}

    // The decoded frame for (gop, frameIndex), or undefined while it decodes.
    get(gop: GopEntry, index: number): VideoFrame | undefined {
        const e = this.entry(gop);
        const i = this.lru.indexOf(gop.t); if (i >= 0) { this.lru.splice(i, 1); this.lru.push(gop.t); }
        if (!e.ready) return undefined;
        return e.frames[Math.max(0, Math.min(index, e.frames.length - 1))];
    }

    // Await a GOP's frames being decoded (best-effort prefetch).
    ensure(gop: GopEntry): Promise<void> { return this.entry(gop).promise; }

    private entry(gop: GopEntry): Entry {
        let e = this.gops.get(gop.t);
        if (e) return e;
        e = { frames: [], ready: false, promise: Promise.resolve() };
        this.gops.set(gop.t, e);
        this.lru.push(gop.t);
        e.promise = (async () => {
            try {
                const bytes = await this.source.getBytes(gop, true);
                e!.frames = await decodeGop(bytes, this.source.frameWalls(gop, gop.n));
                e!.ready = true;
            } catch { this.drop(gop.t); }
        })();
        while (this.lru.length > this.maxGops) this.drop(this.lru[0]);
        return e;
    }

    private drop(t: number): void {
        const e = this.gops.get(t);
        if (e) for (const f of e.frames) { try { f.close(); } catch { /* */ } }
        this.gops.delete(t);
        const i = this.lru.indexOf(t); if (i >= 0) this.lru.splice(i, 1);
    }

    clear(): void { for (const t of Array.from(this.gops.keys())) this.drop(t); }
}

// Decode one GOP's bytes into VideoFrames (a fresh decoder per GOP — each GOP is
// self-contained, so this stays simple and parallel-safe). Frames are returned in
// presentation order. Used by the cache and by live playback.
export async function decodeGop(bytes: Buffer, walls: number[]): Promise<VideoFrame[]> {
    if (typeof VideoDecoder === "undefined") return [];
    const { nals, units } = accessUnitsFromGop(bytes);
    if (!units.length) return [];
    const codec = codecFromSps(nals);
    return new Promise<VideoFrame[]>(resolve => {
        const out: VideoFrame[] = [];
        let settled = false;
        const dec = new VideoDecoder({ output: f => out.push(f), error: () => finish() });
        const finish = () => {
            if (settled) return; settled = true;
            try { dec.close(); } catch { /* */ }
            out.sort((a, b) => a.timestamp - b.timestamp);
            resolve(out);
        };
        try {
            dec.configure({ codec, optimizeForLatency: true });
            for (let i = 0; i < units.length; i++) dec.decode(new EncodedVideoChunk({ type: units[i].key ? "key" : "delta", timestamp: Math.round((walls[i] ?? 0) * 1000), data: units[i].data }));
            dec.flush().then(finish, finish);
        } catch { finish(); }
        setTimeout(finish, 8000); // never hang if flush/output stalls
    });
}
