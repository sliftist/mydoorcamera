// Decode worker — the per-GOP parsing + decoding that was blocking the main thread.
// Receives transferred GOP bytes, splits them into H.264 access units, feeds a
// VideoDecoder, and transfers each decoded VideoFrame to the main thread, which buffers,
// renders, and reports closes back ("closed" messages) for backpressure.
// Built as its own bundle: `build-web --entryPoint ./web/decodeWorker.ts`.

import { accessUnitsFromGop, codecFromSps, AccessUnit } from "./helpers/h264";

const MAX_OUTSTANDING = 60; // decoded frames alive (in decoder or unclosed on main)
const FLUSH_TIMEOUT_MS = 8000;

type PlanGop = { gopT: number; units: AccessUnit[]; codec: string };

let decoder: VideoDecoder | undefined;
let decoderCodec = "";
let generation = 0;
let plan: PlanGop[] = [];
let feedUnit = 0;
let fedSeq = 1;
const fedMap = new Map<number, { gopT: number; fi: number }>();
let sentUnclosed = 0;
let flushGen = -1;

function post(msg: unknown, transfer?: unknown[]): void {
    (self as any).postMessage(msg, transfer || []);
}

function ensureDecoder(codec: string): void {
    if (!decoder || decoder.state === "closed") {
        decoderCodec = "";
        decoder = new VideoDecoder({
            output: onOutput,
            error: e => {
                post({ type: "error", gen: generation, message: (e as any)?.message || String(e) });
                try { decoder?.close(); } catch { /* */ }
                decoder = undefined;
                fedMap.clear();
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
    sentUnclosed++;
    post({ type: "frame", gen: generation, gopT: meta.gopT, fi: meta.fi, frame: f }, [f]);
}

function pump(): void {
    while (sentUnclosed + fedMap.size < MAX_OUTSTANDING) {
        const p = plan[0];
        if (!p) break;
        if (feedUnit >= p.units.length) { plan.shift(); feedUnit = 0; continue; }
        if (feedUnit === 0) {
            try { ensureDecoder(p.codec); } catch (e) {
                post({ type: "error", gen: generation, message: String(e) });
                plan.shift();
                continue;
            }
        }
        if (!decoder) return;
        const u = p.units[feedUnit];
        const ts = fedSeq++;
        try {
            decoder.decode(new EncodedVideoChunk({ type: u.key ? "key" : "delta", timestamp: ts, data: u.data }));
        } catch (e) {
            post({ type: "error", gen: generation, message: String(e) });
            return;
        }
        fedMap.set(ts, { gopT: p.gopT, fi: feedUnit });
        feedUnit++;
    }
    maybeFlushTail();
}

// End of the queued input with frames still inside the decoder: flush the tail out.
function maybeFlushTail(): void {
    if (!decoder || flushGen === generation) return;
    if (!fedMap.size || plan.length) return;
    const gen = generation;
    flushGen = gen;
    void Promise.race([
        decoder.flush().then(() => true, () => false),
        new Promise<boolean>(res => setTimeout(() => res(false), FLUSH_TIMEOUT_MS)),
    ]).then(ok => {
        if (flushGen === gen) flushGen = -1;
        if (gen !== generation) return;
        if (!ok) {
            post({ type: "error", gen: generation, message: "flush hung — rebuilding decoder" });
            try { decoder?.close(); } catch { /* */ }
            decoder = undefined;
            fedMap.clear();
        }
        pump();
    });
}

function onMessage(e: MessageEvent): void {
    const msg = e.data;
    if (msg.type === "reset") {
        generation = msg.gen;
        plan = []; feedUnit = 0;
        fedMap.clear();
        sentUnclosed = 0;
        if (decoder && decoder.state !== "closed") { try { decoder.reset(); } catch { /* */ } }
        return;
    }
    if (msg.gen !== generation) return;
    if (msg.type === "gop") {
        const { nals, units } = accessUnitsFromGop(Buffer.from(msg.bytes as ArrayBuffer));
        post({ type: "gopInfo", gen: generation, gopT: msg.gopT, n: units.length });
        if (units.length) {
            plan.push({ gopT: msg.gopT, units, codec: codecFromSps(nals) });
            pump();
        }
        return;
    }
    if (msg.type === "closed") {
        sentUnclosed -= msg.count;
        pump();
        return;
    }
}

// Only attach in an actual worker context — the bundler requires this module in node at
// build time, and the main-thread bundle must never run it either.
if (typeof self !== "undefined" && typeof (self as any).importScripts === "function") {
    (self as any).onmessage = onMessage;
}
