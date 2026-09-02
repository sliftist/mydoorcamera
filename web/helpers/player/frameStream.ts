// STREAMING DECODE for REVIEW playback — replaces the whole-GOP→ImageBitmap cache.
//
//   getFrame(source, gop, frameIndex) -> Promise<VideoFrame | undefined>
//
// ONE module-level VideoDecoder is kept alive across GOPs (reconfigured only on a codec
// change or after a seek reset — never per frame). It is fed access units a few at a time
// under backpressure, and the decoded frames are held as live VideoFrames in a small
// look-ahead window. The hardware decoder only has ~10-16 output surfaces, so the window
// plus the one on-screen frame stays well under that, and every frame is closed the
// moment it is superseded. This is what makes playback smooth: instead of materializing a
// whole GOP into bitmaps in one main-thread burst (N createImageBitmap copies back to
// back), steady-state per-frame work is a buffered-frame handoff, and decode-ahead
// trickles on between frames.
//
// OWNERSHIP: the returned VideoFrame belongs to this module and is valid until the next
// getFrame call — draw it immediately (the canvas retains the pixels after that). Callers
// never close frames.
//
// Sequential requests (a later frame of a planned GOP, or a following GOP — the feed plan
// auto-extends forward, skipping no-change spans) are served from the window or awaited.
// Anything else is a SEEK: decoder.reset() aborts all queued work — nothing keeps decoding
// for a GOP nobody wants — and a fresh feed starts from the target GOP's IDR. Frames
// before a mid-GOP target still decode (H.264 requires it) but are closed on arrival.

import { observable, runInAction } from "mobx";
import { GopEntry } from "./types";
import { GopSource } from "./gopSource";
import { clockHMS } from "../format";
import { accessUnitsFromGop, codecFromSps, AccessUnit } from "../h264";

const MAX_WINDOW = 8;         // buffered frames + frames still inside the decoder, ahead of current
const PLAN_AHEAD_GOPS = 3;    // GOPs kept queued (bytes fetched + parsed) ahead of the feed point
const FLUSH_TIMEOUT_MS = 8000;
const EXTEND_DRY_RETRY_MS = 2000; // after "no more GOPs ahead", wait this long before asking again

type PlanGop = { gop: GopEntry; units: AccessUnit[]; walls: number[]; codec: string };
type Buffered = { gopT: number; fi: number; frame: VideoFrame };
type FedMeta = { gopT: number; fi: number; fedAt: number };

// Jank witness: any main-thread task over 50ms is a candidate cause of a dropped frame.
// Logged so stutter can be correlated (by timestamp) with the [decode]/[render] lines.
if (typeof PerformanceObserver !== "undefined") {
    try {
        new PerformanceObserver(list => {
            for (const e of list.getEntries()) console.log(`[jank] ${Math.round(e.duration)}ms main-thread task @${Math.round(e.startTime)}`);
        }).observe({ entryTypes: ["longtask"] });
    } catch { /* longtask unsupported */ }
}

let decoder: VideoDecoder | undefined;
let decoderCodec = "";

let sessionSource: GopSource | undefined;
let generation = 0;
let plan: PlanGop[] = [];     // pruned as GOPs finish feeding, so it stays small
let feedGop = 0;              // plan index being fed
let feedUnit = 0;             // next unit within plan[feedGop] (unit index === frame index)
let fedSeq = 1;               // monotonic chunk timestamp — identity only, not a time
const fedMap = new Map<number, FedMeta>();     // ts -> meta for fed-but-not-yet-output chunks
const unitCounts = new Map<number, number>();  // gopT -> decodable frame count (for index clamping)
let buf: Buffered[] = [];
let current: Buffered | undefined;             // the handed-out frame; closed when superseded
let waiter: { gopT: number; fi: number; resolve: (f: VideoFrame | undefined) => void } | undefined;
let lastPlanned: GopEntry | undefined; // survives plan pruning — the anchor to extend from
let extendGen = -1;           // generation with an extend in flight (-1: none)
let extendDryAt = 0;
let flushGen = -1;            // generation with a flush in flight (-1: none)

// Per-GOP decode timing, logged when the GOP's last frame comes out. NOTE the feed is
// paced by playback consumption (backpressure), so wall-clock GOP duration is meaningless;
// what's measured is per-chunk latency: feed of unit i -> output of frame i, with a queue
// that backpressure keeps shallow. That approximates true decode time per frame.
const gopStats = new Map<number, { t0: number; first: number; out: number; n: number; latSum: number; latMax: number }>();

// Observable set of GOPs with frames currently in the window — colours trackbar markers.
const decodedKeys = observable.set<string>();
const keyOf = (level: number, gopT: number): string => level + ":" + gopT;
export function isGopDecoded(level: number, gopT: number): boolean { return decodedKeys.has(keyOf(level, gopT)); }
function syncDecodedKeys(): void {
    const want = new Set<string>();
    if (sessionSource) {
        for (const b of buf) want.add(keyOf(sessionSource.level, b.gopT));
        if (current) want.add(keyOf(sessionSource.level, current.gopT));
    }
    runInAction(() => {
        for (const k of Array.from(decodedKeys.values() as Iterable<string>)) if (!want.has(k)) decodedKeys.delete(k);
        for (const k of want) decodedKeys.add(k);
    });
}

// ============================ public API ============================

export async function getFrame(src: GopSource, gop: GopEntry, index: number): Promise<VideoFrame | undefined> {
    if (typeof VideoDecoder === "undefined") return undefined;
    if (src.isNoChange(gop)) return undefined; // static span carries no video of its own
    const want = Math.max(0, index);
    if (sessionSource === src) {
        const fi = clampFi(gop.t, want);
        if (current && current.gopT === gop.t && current.fi === fi) return current.frame;
        const pos = buf.findIndex(b => b.gopT === gop.t && b.fi === fi);
        if (pos >= 0) { serveFromBuf(pos); pump(); return current!.frame; }
        if (stillComing(gop.t, fi)) return waitFor(gop.t, fi, "starved");
    }
    restart(src, gop, want);
    return waitFor(gop.t, want, "seek");
}

// Drop this source's session (a player teardown): close every frame and abort queued decodes.
export function releaseStream(src: GopSource): void {
    if (sessionSource !== src) return;
    generation++;
    clearSession();
    sessionSource = undefined;
    const w = waiter; waiter = undefined; w?.resolve(undefined);
    if (decoder && decoder.state !== "closed") { try { decoder.reset(); } catch { /* */ } }
    syncDecodedKeys();
}

// ============================ session ============================

function clearSession(): void {
    closeFrame(current); current = undefined;
    for (const b of buf) closeFrame(b);
    buf = [];
    fedMap.clear();
    unitCounts.clear();
    gopStats.clear();
    plan = []; feedGop = 0; feedUnit = 0;
    lastPlanned = undefined;
    extendDryAt = 0;
}

function restart(src: GopSource, gop: GopEntry, fi: number): void {
    generation++;
    const gen = generation;
    clearSession();
    sessionSource = src;
    // reset() aborts every queued decode — the whole point: a seek never waits for (or
    // wastes time finishing) the previous GOP. The decoder object itself is kept; reset
    // leaves it unconfigured, so the next feed reconfigures it (cheap, and required).
    if (decoder && decoder.state !== "closed") { try { decoder.reset(); } catch { /* */ } }
    syncDecodedKeys();
    console.log(`[decode] seek ${clockHMS(gop.t)} #${fi}`);
    void (async () => {
        try {
            const bytes = await src.getBytes(gop, true);
            if (gen !== generation) return;
            if (!pushPlanGop(src, gop, bytes)) {
                const w = waiter; waiter = undefined; w?.resolve(undefined);
                return;
            }
            if (waiter && waiter.gopT === gop.t) waiter.fi = clampFi(gop.t, waiter.fi);
            pump();
        } catch (e) {
            if (gen !== generation) return;
            console.warn("[decode] fetch failed", e);
            const w = waiter; waiter = undefined; w?.resolve(undefined);
        }
    })();
}

function pushPlanGop(src: GopSource, gop: GopEntry, bytes: Buffer): boolean {
    const { nals, units } = accessUnitsFromGop(bytes);
    if (!units.length) return false;
    plan.push({ gop, units, walls: src.frameWalls(gop, units.length), codec: codecFromSps(nals) });
    unitCounts.set(gop.t, units.length);
    lastPlanned = gop;
    return true;
}

function clampFi(gopT: number, fi: number): number {
    const n = unitCounts.get(gopT);
    return n ? Math.min(fi, n - 1) : fi;
}

// Is (gopT, fi) still going to come out of the feed (queued in the decoder or unfed in the plan)?
function stillComing(gopT: number, fi: number): boolean {
    for (const m of fedMap.values()) if (m.gopT === gopT && m.fi === fi) return true;
    for (let i = feedGop; i < plan.length; i++) {
        if (plan[i].gop.t !== gopT) continue;
        const from = i === feedGop ? feedUnit : 0;
        return fi >= from && fi < plan[i].units.length;
    }
    return false;
}

// ============================ window ============================

function closeFrame(b: Buffered | undefined): void {
    if (b) { try { b.frame.close(); } catch { /* */ } }
}

// Hand out buf[pos] as the current frame; everything older (the skipped-over frames and the
// previous current) is closed, freeing decoder surfaces.
function serveFromBuf(pos: number): void {
    closeFrame(current);
    for (let i = 0; i < pos; i++) closeFrame(buf[i]);
    current = buf[pos];
    buf = buf.slice(pos + 1);
    syncDecodedKeys();
}

// While a specific frame is awaited, buffered frames OLDER than it are dead weight (the
// playhead moved past them) — close them so the window can never wedge the feed shut.
function trimForWaiter(): void {
    while (waiter && buf.length && !(buf[0].gopT === waiter.gopT && buf[0].fi === waiter.fi)) {
        closeFrame(buf.shift());
    }
}

// "starved": playback wanted a frame the window didn't have yet — these waits ARE the
// player-side stalls, so every one is logged. "seek": a deliberate jump; logged too, but
// expected to take a fetch+decode.
function waitFor(gopT: number, fi: number, why: "starved" | "seek"): Promise<VideoFrame | undefined> {
    if (waiter) waiter.resolve(undefined); // superseded by this newer request
    const t0 = performance.now();
    return new Promise(res => {
        waiter = {
            gopT, fi,
            resolve: f => {
                if (f) console.log(`[decode] ${why} ${Math.round(performance.now() - t0)}ms for ${clockHMS(gopT)}#${fi}`);
                res(f);
            },
        };
        trimForWaiter();
        pump();
    });
}

// ============================ decoder ============================

function ensureDecoder(codec: string): void {
    if (!decoder || decoder.state === "closed") {
        decoderCodec = "";
        decoder = new VideoDecoder({
            output: onOutput,
            error: e => {
                console.warn("[decode] decoder error", (e as any)?.message || e);
                try { decoder?.close(); } catch { /* */ }
                decoder = undefined;
                fedMap.clear();
                const w = waiter; waiter = undefined; w?.resolve(undefined);
            },
        });
    }
    if (decoder.state === "unconfigured" || decoderCodec !== codec) {
        if (decoderCodec !== codec) console.log(`[decode] configure ${codec}`);
        decoder.configure({ codec, optimizeForLatency: true });
        decoderCodec = codec;
    }
}

function onOutput(f: VideoFrame): void {
    const meta = fedMap.get(f.timestamp);
    fedMap.delete(f.timestamp);
    if (!meta) { try { f.close(); } catch { /* */ } return; } // stale (post-reset) output
    const s = gopStats.get(meta.gopT);
    if (s) {
        s.out++;
        const lat = performance.now() - meta.fedAt;
        s.latSum += lat; if (lat > s.latMax) s.latMax = lat;
        if (!s.first) s.first = Date.now() - s.t0;
        if (s.out >= s.n) {
            console.log(`[decode] ${clockHMS(meta.gopT)} ${s.n}f: first ${s.first}ms, per-frame avg ${(s.latSum / s.out).toFixed(1)}ms max ${Math.round(s.latMax)}ms`);
            gopStats.delete(meta.gopT);
        }
    }
    buf.push({ gopT: meta.gopT, fi: meta.fi, frame: f });
    trimForWaiter();
    if (waiter && buf.length && buf[0].gopT === waiter.gopT && buf[0].fi === waiter.fi) {
        serveFromBuf(0);
        const w = waiter; waiter = undefined;
        w.resolve(current!.frame);
    }
    syncDecodedKeys();
    pump();
}

// ============================ the feed ============================

// Feed the decoder while the look-ahead window has room. Re-entered from every event that
// frees a slot or adds input (frame served, frame output, plan extended).
function pump(): void {
    while (buf.length + fedMap.size < MAX_WINDOW) {
        const p = plan[feedGop];
        if (!p) break;
        if (feedUnit >= p.units.length) {
            feedGop++; feedUnit = 0;
            while (feedGop > 0) { plan.shift(); feedGop--; } // prune fully-fed GOPs
            continue;
        }
        if (feedUnit === 0) {
            try { ensureDecoder(p.codec); } catch (e) { console.warn("[decode] configure failed", e); return; }
            gopStats.set(p.gop.t, { t0: Date.now(), first: 0, out: 0, n: p.units.length, latSum: 0, latMax: 0 });
        }
        if (!decoder) return;
        const u = p.units[feedUnit];
        const ts = fedSeq++;
        try {
            decoder.decode(new EncodedVideoChunk({ type: u.key ? "key" : "delta", timestamp: ts, data: u.data }));
        } catch (e) {
            console.warn("[decode] decode failed", e);
            return;
        }
        fedMap.set(ts, { gopT: p.gop.t, fi: feedUnit, fedAt: performance.now() });
        feedUnit++;
    }
    maybeExtend();
    maybeFlushTail();
}

function inputRemaining(): boolean {
    for (let i = feedGop; i < plan.length; i++) {
        if ((i === feedGop ? feedUnit : 0) < plan[i].units.length) return true;
    }
    return false;
}

// Keep the plan topped up ahead of the feed point, skipping no-change spans (they have no
// bytes; DayPlayer shows their referenced frame separately) — so read-ahead flows straight
// across a static stretch into the next active GOP.
function maybeExtend(): void {
    if (extendGen === generation || !sessionSource) return;
    if (plan.length - feedGop > PLAN_AHEAD_GOPS) return;
    const last = lastPlanned;
    if (!last) return; // a restart's first GOP hasn't landed yet
    if (extendDryAt && Date.now() - extendDryAt < EXTEND_DRY_RETRY_MS) return;
    const src = sessionSource;
    const gen = generation;
    extendGen = gen;
    void (async () => {
        let pushed = 0;
        try {
            const fromWall = last.t + src.gopDurMs(last) + 1;
            const gops = await src.gopsFrom(fromWall, PLAN_AHEAD_GOPS + 2);
            for (const g of gops) {
                if (gen !== generation) return;
                if (src.isNoChange(g) || plan.some(p => p.gop.t === g.t)) continue;
                const bytes = await src.getBytes(g, false); // cancellable: dropped on a seek
                if (gen !== generation) return;
                if (pushPlanGop(src, g, bytes)) pushed++;
                if (plan.length - feedGop > PLAN_AHEAD_GOPS) break;
            }
            extendDryAt = pushed ? 0 : Date.now(); // nothing ahead (yet) — back off briefly
            pump();
        } catch { /* transient (or cancelled) — retried on a later pump */ }
        finally { if (extendGen === gen) extendGen = -1; }
    })();
}

// End of the plan with frames still inside the decoder and someone waiting: flush to get the
// tail out. Guarded by a timeout — a hung flush means a wedged decoder, so rebuild it.
function maybeFlushTail(): void {
    if (!decoder || !waiter || flushGen === generation) return;
    if (!fedMap.size || inputRemaining()) return;
    const gen = generation;
    flushGen = gen;
    const t0 = Date.now();
    void Promise.race([
        decoder.flush().then(() => true, () => false),
        new Promise<boolean>(res => setTimeout(() => res(false), FLUSH_TIMEOUT_MS)),
    ]).then(ok => {
        if (flushGen === gen) flushGen = -1;
        if (gen !== generation) return;
        if (!ok) {
            console.warn(`[decode] flush hung after ${Date.now() - t0}ms — rebuilding decoder`);
            try { decoder?.close(); } catch { /* */ }
            decoder = undefined;
            fedMap.clear();
            const w = waiter; waiter = undefined; w?.resolve(undefined);
        }
        pump();
    });
}
