// Main-thread side of review-playback decoding. All parsing + decoding lives in
// decodeWorker.ts; this keeps the decoded-frame window, hands frames to the player, and
// reports closed frames back to the worker for backpressure. Frames handed out stay owned
// here (valid until the next getFrame); callers never close them.

import { observable, runInAction } from "mobx";
import { measureBlock } from "socket-function/src/profiling/measure";
import { GopEntry } from "./types";
import { GopSource } from "./gopSource";
import { BUILD_TIMESTAMP } from "../../../buildVersion";

const PLAN_AHEAD_GOPS = 3;
const EXTEND_DRY_RETRY_MS = 2000;

type Buffered = { gopT: number; fi: number; frame: VideoFrame };

let worker: Worker | undefined;
let sessionSource: GopSource | undefined;
let generation = 0;
let buf: Buffered[] = [];
let current: Buffered | undefined;
let waiter: { gopT: number; fi: number; resolve: (f: VideoFrame | undefined) => void } | undefined;
const unitCounts = new Map<number, number>();  // gopT -> decodable frame count (for index clamping)
const received = new Map<number, number>();    // gopT -> next frame index expected from the worker
let plannedOrder: number[] = [];
const plannedSet = new Set<number>();
const badGops = new Set<number>();             // parsed to zero units — don't re-send
let lastPlanned: GopEntry | undefined;
let extendGen = -1;
let extendDryAt = 0;
let closedPending = 0;
let closedFlushQueued = false;

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
    if (typeof Worker === "undefined" || typeof VideoDecoder === "undefined") return undefined;
    if (src.isNoChange(gop)) return undefined;
    const want = Math.max(0, index);
    if (sessionSource === src) {
        const fi = clampFi(gop.t, want);
        if (current && current.gopT === gop.t && current.fi === fi) return current.frame;
        const pos = buf.findIndex(b => b.gopT === gop.t && b.fi === fi);
        if (pos >= 0) { serveFromBuf(pos); maybeExtend(); return current!.frame; }
        if (stillComing(gop.t, fi)) return waitFor(gop.t, fi);
    }
    // The waiter's fi is clamped down when this GOP's gopInfo arrives from the worker.
    restart(src, gop);
    return waitFor(gop.t, want);
}

export function releaseStream(src: GopSource): void {
    if (sessionSource !== src) return;
    generation++;
    clearSession();
    sessionSource = undefined;
    const w = waiter; waiter = undefined; w?.resolve(undefined);
    if (worker) worker.postMessage({ type: "reset", gen: generation });
    syncDecodedKeys();
}

// ============================ session ============================

function clearSession(): void {
    // Old-generation frames close WITHOUT a "closed" report — the worker's reset zeroes
    // its outstanding counter, so acking them would double-credit the new generation.
    if (current) { try { current.frame.close(); } catch { /* */ } current = undefined; }
    for (const b of buf) { try { b.frame.close(); } catch { /* */ } }
    buf = [];
    unitCounts.clear();
    received.clear();
    plannedOrder = [];
    plannedSet.clear();
    badGops.clear();
    lastPlanned = undefined;
    extendDryAt = 0;
    closedPending = 0;
}

function restart(src: GopSource, gop: GopEntry): void {
    generation++;
    const gen = generation;
    clearSession();
    sessionSource = src;
    const w = ensureWorker();
    if (w) w.postMessage({ type: "reset", gen });
    syncDecodedKeys();
    void (async () => {
        try {
            const bytes = await src.getBytes(gop, true);
            if (gen !== generation) return;
            sendGop(src, gop, bytes);
            maybeExtend();
        } catch (e) {
            if (gen !== generation) return;
            console.warn("[decode] fetch failed", e);
            const pending = waiter; waiter = undefined; pending?.resolve(undefined);
        }
    })();
}

function sendGop(src: GopSource, gop: GopEntry, bytes: Buffer): void {
    const w = ensureWorker();
    if (!w) return;
    plannedSet.add(gop.t);
    plannedOrder.push(gop.t);
    lastPlanned = gop;
    const ab = measureBlock(() => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "frameStream|transferCopy");
    w.postMessage({ type: "gop", gen: generation, gopT: gop.t, bytes: ab }, [ab]);
}

function clampFi(gopT: number, fi: number): number {
    const n = unitCounts.get(gopT);
    return n ? Math.min(fi, n - 1) : fi;
}

// Will (gopT, fi) still arrive from the worker (planned and not yet delivered)?
function stillComing(gopT: number, fi: number): boolean {
    if (!plannedSet.has(gopT)) return false;
    if (fi < (received.get(gopT) || 0)) return false;
    const n = unitCounts.get(gopT);
    return n === undefined || fi < n;
}

// ============================ window ============================

function closeFrame(b: Buffered | undefined): void {
    if (!b) return;
    try { b.frame.close(); } catch { /* */ }
    closedPending++;
    if (!closedFlushQueued) {
        closedFlushQueued = true;
        queueMicrotask(() => {
            closedFlushQueued = false;
            const n = closedPending;
            closedPending = 0;
            if (n && worker) worker.postMessage({ type: "closed", gen: generation, count: n });
        });
    }
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
        maybeExtend();
    });
}

// ============================ worker ============================

function ensureWorker(): Worker | undefined {
    if (typeof Worker === "undefined") return undefined;
    if (!worker) {
        worker = new Worker(`./decodeWorker.js?v=${BUILD_TIMESTAMP}`);
        worker.onmessage = e => measureBlock(() => onWorkerMessage(e), "frameStream|onWorkerMessage");
        worker.onerror = e => console.warn("[decode] worker error", (e as any)?.message || e);
    }
    return worker;
}

function onWorkerMessage(e: MessageEvent): void {
    const msg = e.data;
    if (msg.type === "frame") {
        const f: VideoFrame = msg.frame;
        if (msg.gen !== generation) { try { f.close(); } catch { /* */ } return; }
        received.set(msg.gopT, msg.fi + 1);
        buf.push({ gopT: msg.gopT, fi: msg.fi, frame: f });
        trimForWaiter();
        if (waiter && buf.length && buf[0].gopT === waiter.gopT && buf[0].fi === waiter.fi) {
            serveFromBuf(0);
            const w = waiter; waiter = undefined;
            w.resolve(current!.frame);
        }
        syncDecodedKeys();
        maybeExtend();
        return;
    }
    if (msg.gen !== generation) return;
    if (msg.type === "gopInfo") {
        if (!msg.n) {
            plannedSet.delete(msg.gopT);
            badGops.add(msg.gopT);
            if (waiter && waiter.gopT === msg.gopT) { const w = waiter; waiter = undefined; w.resolve(undefined); }
        } else {
            unitCounts.set(msg.gopT, msg.n);
            if (waiter && waiter.gopT === msg.gopT) waiter.fi = Math.min(waiter.fi, msg.n - 1);
        }
        maybeExtend();
        return;
    }
    if (msg.type === "error") {
        console.warn("[decode] worker decode error", msg.message);
        const w = waiter; waiter = undefined; w?.resolve(undefined);
    }
}

// ============================ plan extension ============================

// Planned GOPs not yet fully delivered (prunes finished ones off the head).
function remainingPlanned(): number {
    while (plannedOrder.length) {
        const t = plannedOrder[0];
        if (!plannedSet.has(t)) { plannedOrder.shift(); continue; }
        const n = unitCounts.get(t);
        if (n !== undefined && (received.get(t) || 0) >= n) { plannedOrder.shift(); continue; }
        break;
    }
    return plannedOrder.length;
}

function maybeExtend(): void {
    if (extendGen === generation || !sessionSource) return;
    if (remainingPlanned() > PLAN_AHEAD_GOPS) return;
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
                if (src.isNoChange(g) || plannedSet.has(g.t) || badGops.has(g.t)) continue;
                const bytes = await src.getBytes(g, false);
                if (gen !== generation) return;
                sendGop(src, g, bytes);
                pushed++;
                if (remainingPlanned() > PLAN_AHEAD_GOPS) break;
            }
            extendDryAt = pushed ? 0 : Date.now();
        } catch { /* transient (or cancelled) — retried on a later event */ }
        finally { if (extendGen === gen) extendGen = -1; }
    })();
}
