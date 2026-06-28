// Generative decoded-frame cache — a single async function.
//
//   getFrame(source, gop, index) -> Promise<VideoFrame | undefined>
//
// You ask for a frame; if its GOP is cached you get it, otherwise the whole GOP is decoded
// (concurrent requests for the same GOP share one decode) and cached. The cache manages its
// own state: a module-level map of GOP -> decoded frames, bounded to MAX_GOPS by a
// least-recently-used sweep (only ~100 entries, so a brute-force scan is fine). Evicted
// GOPs close their VideoFrames. There is no clear() — the LRU bound is the whole policy.

import { observable, runInAction } from "mobx";
import { GopEntry } from "./types";
import { GopSource } from "./gopSource";
import { clockHMS } from "../format";
import { accessUnitsFromGop, codecFromSps } from "../h264";

const MAX_GOPS = 100;

type Entry = { frames: Promise<VideoFrame[]>; used: number };
const entries = new Map<string, Entry>();
let useClock = 0;

// Observable set of GOP keys currently decoded in the cache — read it in an @observer
// (via isGopDecoded) to colour the trackbar markers for decoded GOPs.
const decodedKeys = observable.set<string>();
const keyOf = (level: number, gopT: number): string => level + ":" + gopT;
export function isGopDecoded(level: number, gopT: number): boolean { return decodedKeys.has(keyOf(level, gopT)); }

export async function getFrame(source: GopSource, gop: GopEntry, index: number): Promise<VideoFrame | undefined> {
    const key = keyOf(source.level, gop.t);
    let entry = entries.get(key);
    if (!entry) {
        entry = { used: 0, frames: loadGop(source, gop, key) };
        entries.set(key, entry);
        entry.frames.catch(() => { entries.delete(key); }); // a failed decode shouldn't stick
    }
    entry.used = ++useClock;
    evictOldest();
    const frames = await entry.frames;
    if (!frames.length) return undefined;
    return frames[Math.max(0, Math.min(index, frames.length - 1))];
}

// Fetch bytes + decode one GOP, logging start and decode duration, and marking it decoded.
async function loadGop(source: GopSource, gop: GopEntry, key: string): Promise<VideoFrame[]> {
    console.log(`[decode] start ${key} @ ${clockHMS(gop.t)}`);
    const t0 = Date.now();
    const bytes = await source.getBytes(gop, true);
    const frames = await decodeGop(bytes, source.frameWalls(gop, gop.n));
    console.log(`[decode] done  ${key} ${frames.length}f in ${Date.now() - t0}ms`);
    runInAction(() => { decodedKeys.add(key); });
    return frames;
}

function evictOldest(): void {
    while (entries.size > MAX_GOPS) {
        let oldestKey: string | undefined;
        let oldestUsed = Infinity;
        for (const [k, v] of entries) {
            if (v.used < oldestUsed) {
                oldestUsed = v.used;
                oldestKey = k;
            }
        }
        if (oldestKey === undefined) break;
        const evicted = entries.get(oldestKey)!;
        entries.delete(oldestKey);
        const key = oldestKey;
        runInAction(() => { decodedKeys.delete(key); });
        void evicted.frames
            .then(frames => { for (const f of frames) { try { f.close(); } catch { /* */ } } })
            .catch(() => { /* */ });
    }
}

// Decode one GOP's bytes into VideoFrames (a fresh decoder per GOP — each GOP is
// self-contained, so this stays simple and parallel-safe). Returned in presentation order.
// Also used by the live player.
export async function decodeGop(bytes: Buffer, walls: number[]): Promise<VideoFrame[]> {
    if (typeof VideoDecoder === "undefined") return [];
    const { nals, units } = accessUnitsFromGop(bytes);
    if (!units.length) return [];
    const codec = codecFromSps(nals);
    return new Promise<VideoFrame[]>(resolve => {
        const out: VideoFrame[] = [];
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            try { dec.close(); } catch { /* */ }
            out.sort((a, b) => a.timestamp - b.timestamp);
            resolve(out);
        };
        const dec = new VideoDecoder({ output: f => out.push(f), error: () => finish() });
        try {
            dec.configure({ codec, optimizeForLatency: true });
            for (let i = 0; i < units.length; i++) {
                dec.decode(new EncodedVideoChunk({
                    type: units[i].key ? "key" : "delta",
                    timestamp: Math.round((walls[i] ?? 0) * 1000),
                    data: units[i].data,
                }));
            }
            dec.flush().then(finish, finish);
        } catch {
            finish();
        }
        setTimeout(finish, 8000); // never hang if flush/output stalls
    });
}
