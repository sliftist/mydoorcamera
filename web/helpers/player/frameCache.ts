// Generative decoded-frame cache — a single async function.
//
//   getFrame(source, gop, index) -> Promise<ImageBitmap | undefined>
//
// You ask for a frame; if its GOP is cached you get it, otherwise the whole GOP is decoded
// (concurrent requests for the same GOP share one decode) and cached. Bounded to MAX_GOPS by
// a least-recently-used sweep.
//
// IMPORTANT: we cache ImageBitmaps, NOT VideoFrames. Hardware H.264 decoders only have a
// small pool of output surfaces (~10-16); holding decoded VideoFrames open exhausts that pool
// and the decoder stalls mid-GOP (flush() never resolves). So as each frame comes out of the
// decoder we copy it into an ImageBitmap and close the VideoFrame right away, freeing the
// surface — which also lets the decode finish.

import { observable, runInAction } from "mobx";
import { GopEntry } from "./types";
import { GopSource } from "./gopSource";
import { clockHMS } from "../format";
import { accessUnitsFromGop, codecFromSps } from "../h264";

const MAX_GOPS = 16;
const MAX_FRAME_WIDTH = 1280; // downscale cached bitmaps to ~720p to bound memory

type Entry = { frames: Promise<ImageBitmap[]>; used: number };
const entries = new Map<string, Entry>();
let useClock = 0;

// Observable set of GOP keys currently decoded — read via isGopDecoded() in an @observer to
// colour the trackbar markers for decoded GOPs.
const decodedKeys = observable.set<string>();
const keyOf = (level: number, gopT: number): string => level + ":" + gopT;
export function isGopDecoded(level: number, gopT: number): boolean { return decodedKeys.has(keyOf(level, gopT)); }

export async function getFrame(source: GopSource, gop: GopEntry, index: number): Promise<ImageBitmap | undefined> {
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

async function loadGop(source: GopSource, gop: GopEntry, key: string): Promise<ImageBitmap[]> {
    console.log(`[decode] start ${key} @ ${clockHMS(gop.t)}`);
    const bytes = await source.getBytes(gop, true);
    const frames = await decodeGop(bytes, source.frameWalls(gop, gop.n));
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
        const key = oldestKey;
        entries.delete(key);
        runInAction(() => { decodedKeys.delete(key); });
        void evicted.frames
            .then(frames => { for (const b of frames) { try { b.close(); } catch { /* */ } } })
            .catch(() => { /* */ });
    }
}

// ---- decoding: ONE shared decoder, fed one GOP at a time ----
// Reusing a single VideoDecoder avoids per-GOP codec init and hardware-decoder contention.
let decoder: VideoDecoder | undefined;
let decoderCodec = "";
let collect: ((frame: VideoFrame) => void) | null = null; // output sink for the in-flight decode (serialized)
let decodeChain: Promise<unknown> = Promise.resolve();

function ensureDecoder(codec: string): void {
    if (decoder && decoder.state !== "closed" && decoderCodec === codec) return;
    if (decoder && decoder.state !== "closed") { try { decoder.close(); } catch { /* */ } }
    decoderCodec = codec;
    decoder = new VideoDecoder({
        output: f => { if (collect) collect(f); else { try { f.close(); } catch { /* */ } } },
        error: e => { console.warn("[decode] decoder error", (e as any)?.message || e); try { decoder?.close(); } catch { /* */ } decoder = undefined; },
    });
    decoder.configure({ codec, optimizeForLatency: true });
}

// Decode one GOP into ImageBitmaps (presentation order). Serialized through the shared decoder.
// Each frame is copied to a bitmap and its VideoFrame closed immediately (frees decoder surfaces).
export function decodeGop(bytes: Buffer, walls: number[]): Promise<ImageBitmap[]> {
    const run = decodeChain.then(() => decodeOne(bytes, walls));
    decodeChain = run.then(() => { /* */ }, () => { /* keep the chain alive past errors */ });
    return run;
}

async function decodeOne(bytes: Buffer, walls: number[]): Promise<ImageBitmap[]> {
    if (typeof VideoDecoder === "undefined" || typeof createImageBitmap === "undefined") return [];
    const { nals, units } = accessUnitsFromGop(bytes);
    if (!units.length) return [];
    try { ensureDecoder(codecFromSps(nals)); } catch (e) { console.warn("[decode] configure failed", e); return []; }
    if (!decoder) return [];

    const t0 = Date.now();
    const made: { ts: number; bmp: ImageBitmap }[] = [];
    const tasks: Promise<void>[] = [];
    collect = (f: VideoFrame) => {
        const ts = f.timestamp;
        const dw = f.displayWidth || MAX_FRAME_WIDTH, dh = f.displayHeight || 720;
        const scale = Math.min(1, MAX_FRAME_WIDTH / dw);
        const opts = { resizeWidth: Math.max(1, Math.round(dw * scale)), resizeHeight: Math.max(1, Math.round(dh * scale)), resizeQuality: "medium" as const };
        // Copy to a bitmap, then close the VideoFrame ASAP so the decoder gets its surface back.
        tasks.push(createImageBitmap(f as any, opts)
            .then(bmp => { made.push({ ts, bmp }); })
            .catch(() => { /* */ })
            .finally(() => { try { f.close(); } catch { /* */ } }));
    };

    let flushed = false;
    try {
        for (let i = 0; i < units.length; i++) {
            decoder.decode(new EncodedVideoChunk({
                type: units[i].key ? "key" : "delta",
                timestamp: Math.round((walls[i] ?? 0) * 1000),
                data: units[i].data,
            }));
        }
        await Promise.race([
            decoder.flush().then(() => { flushed = true; }, () => { /* */ }),
            new Promise<void>(res => setTimeout(res, 8000)),
        ]);
    } catch (e) {
        console.warn("[decode] failed", e);
    }
    await Promise.all(tasks); // wait for bitmap copies (and the frame closes)
    collect = null;
    if (!flushed && decoder && decoder.state !== "closed") { try { decoder.close(); } catch { /* */ } decoder = undefined; } // hung -> rebuild
    made.sort((a, b) => a.ts - b.ts);
    console.log(`[decode] done ${made.length}f in ${Date.now() - t0}ms`);
    return made.map(m => m.bmp);
}
