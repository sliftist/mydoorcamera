import { observable, runInAction } from "mobx";
import { GopEntry } from "./types";
import { GopSource } from "./gopSource";
import { accessUnitsFromGop, codecFromSps, AccessUnit } from "../h264";

const MAX_WINDOW = 60;
const PLAN_AHEAD_GOPS = 3;
const FLUSH_TIMEOUT_MS = 8000;
const EXTEND_DRY_RETRY_MS = 2000;

type PlanGop = { gop: GopEntry; units: AccessUnit[]; walls: number[]; codec: string };
type Buffered = { gopT: number; fi: number; frame: VideoFrame };
type FedMeta = { gopT: number; fi: number };

let decoder: VideoDecoder | undefined;
let decoderCodec = "";

let sessionSource: GopSource | undefined;
let generation = 0;
let plan: PlanGop[] = [];
let feedGop = 0;
let feedUnit = 0;
let fedSeq = 1;
const fedMap = new Map<number, FedMeta>();
const unitCounts = new Map<number, number>();
let buf: Buffered[] = [];
let current: Buffered | undefined;
let waiter: { gopT: number; fi: number; resolve: (f: VideoFrame | undefined) => void } | undefined;
let lastPlanned: GopEntry | undefined;
let extendGen = -1;
let extendDryAt = 0;
let flushGen = -1;

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

export async function getFrame(src: GopSource, gop: GopEntry, index: number): Promise<VideoFrame | undefined> {
    if (typeof VideoDecoder === "undefined") return undefined;
    if (src.isNoChange(gop)) return undefined;
    const want = Math.max(0, index);
    if (sessionSource === src) {
        const fi = clampFi(gop.t, want);
        if (current && current.gopT === gop.t && current.fi === fi) return current.frame;
        const pos = buf.findIndex(b => b.gopT === gop.t && b.fi === fi);
        if (pos >= 0) { serveFromBuf(pos); pump(); return current!.frame; }
        if (stillComing(gop.t, fi)) return waitFor(gop.t, fi);
    }
    restart(src, gop, want);
    return waitFor(gop.t, want);
}

export function releaseStream(src: GopSource): void {
    if (sessionSource !== src) return;
    generation++;
    clearSession();
    sessionSource = undefined;
    const w = waiter; waiter = undefined; w?.resolve(undefined);
    if (decoder && decoder.state !== "closed") { try { decoder.reset(); } catch { /* */ } }
    syncDecodedKeys();
}

function clearSession(): void {
    closeFrame(current); current = undefined;
    for (const b of buf) closeFrame(b);
    buf = [];
    fedMap.clear();
    unitCounts.clear();
    plan = []; feedGop = 0; feedUnit = 0;
    lastPlanned = undefined;
    extendDryAt = 0;
}

function restart(src: GopSource, gop: GopEntry, fi: number): void {
    generation++;
    const gen = generation;
    clearSession();
    sessionSource = src;
    if (decoder && decoder.state !== "closed") { try { decoder.reset(); } catch { /* */ } }
    syncDecodedKeys();
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

function stillComing(gopT: number, fi: number): boolean {
    for (const m of fedMap.values()) if (m.gopT === gopT && m.fi === fi) return true;
    for (let i = feedGop; i < plan.length; i++) {
        if (plan[i].gop.t !== gopT) continue;
        const from = i === feedGop ? feedUnit : 0;
        return fi >= from && fi < plan[i].units.length;
    }
    return false;
}

function closeFrame(b: Buffered | undefined): void {
    if (b) { try { b.frame.close(); } catch { /* */ } }
}

function serveFromBuf(pos: number): void {
    closeFrame(current);
    for (let i = 0; i < pos; i++) closeFrame(buf[i]);
    current = buf[pos];
    buf = buf.slice(pos + 1);
    syncDecodedKeys();
}

function trimForWaiter(): void {
    while (waiter && buf.length && !(buf[0].gopT === waiter.gopT && buf[0].fi === waiter.fi)) {
        closeFrame(buf.shift());
    }
}

function waitFor(gopT: number, fi: number): Promise<VideoFrame | undefined> {
    if (waiter) waiter.resolve(undefined);
    return new Promise(res => {
        waiter = { gopT, fi, resolve: res };
        trimForWaiter();
        pump();
    });
}

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
        decoder.configure({ codec, optimizeForLatency: true });
        decoderCodec = codec;
    }
}

function onOutput(f: VideoFrame): void {
    const meta = fedMap.get(f.timestamp);
    fedMap.delete(f.timestamp);
    if (!meta) { try { f.close(); } catch { /* */ } return; }
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

function pump(): void {
    while (buf.length + fedMap.size < MAX_WINDOW) {
        const p = plan[feedGop];
        if (!p) break;
        if (feedUnit >= p.units.length) {
            feedGop++; feedUnit = 0;
            while (feedGop > 0) { plan.shift(); feedGop--; }
            continue;
        }
        if (feedUnit === 0) {
            try { ensureDecoder(p.codec); } catch (e) { console.warn("[decode] configure failed", e); return; }
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
        fedMap.set(ts, { gopT: p.gop.t, fi: feedUnit });
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

function maybeExtend(): void {
    if (extendGen === generation || !sessionSource) return;
    if (plan.length - feedGop > PLAN_AHEAD_GOPS) return;
    const last = lastPlanned;
    if (!last) return;
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
                const bytes = await src.getBytes(g, false);
                if (gen !== generation) return;
                if (pushPlanGop(src, g, bytes)) pushed++;
                if (plan.length - feedGop > PLAN_AHEAD_GOPS) break;
            }
            extendDryAt = pushed ? 0 : Date.now();
            pump();
        } catch { /* */ }
        finally { if (extendGen === gen) extendGen = -1; }
    })();
}

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
