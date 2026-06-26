// Client-side keyframe thumbnails for activity regions.
//   getThumbUrl({level, t})  -- read inside @observer render(); returns a blob URL
//   for the decoded keyframe of the GOP at (level, t), or undefined while loading.
//
// Pipeline: asyncCache (in-memory, mobx-reactive) wraps a producer that first checks
// a persistent BulkDatabase2 cache of JPEG bytes; on a miss it fetches the GOP bytes
// (server RPC), decodes the keyframe with WebCodecs to a small JPEG, persists it, and
// returns a blob URL. Decode time is logged so cache hits/misses are visible.

import { asyncCache } from "sliftutils/render-utils/asyncObservable";
import { BulkDatabase2 } from "sliftutils/storage/BulkDatabase2/BulkDatabase2";
import { splitFramedNals } from "../../src/annexb";
import { api } from "./session";

const THUMB_W = 256, THUMB_H = 144;
const START = new Uint8Array([0, 0, 0, 1]);
const thumbDb = new BulkDatabase2<{ key: string; jpeg: Uint8Array }>("activityThumbs");

function codecFromSps(nals: Buffer[]): string {
    const sps = nals.find(n => (n[0] & 0x1f) === 7);
    if (!sps || sps.length < 4) return "avc1.4D0028";
    const hex = (b: number) => b.toString(16).padStart(2, "0");
    return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

function concat(parts: Uint8Array[]): Uint8Array {
    let len = 0; for (const p of parts) len += p.length;
    const out = new Uint8Array(len); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

// Decode the SPS+PPS+IDR of a GOP to a small JPEG via WebCodecs (Annex-B).
function decodeKeyframe(bytes: Uint8Array): Promise<Uint8Array> {
    const W: any = window as any;
    if (typeof W.VideoDecoder !== "function") return Promise.reject(new Error("no WebCodecs"));
    const nals = splitFramedNals(Buffer.from(bytes));
    const au: Uint8Array[] = [];
    for (const n of nals) { const t = n[0] & 0x1f; if (t === 7 || t === 8 || t === 5) { au.push(START, n); } }
    const data = concat(au);
    const codec = codecFromSps(nals);
    return new Promise<Uint8Array>((resolve, reject) => {
        let done = false;
        const finish = (e?: any) => { if (done) return; done = true; try { dec.close(); } catch { /* */ } if (e) reject(e); };
        const dec = new W.VideoDecoder({
            output: (frame: any) => {
                if (done) { frame.close(); return; }
                try {
                    const canvas = new OffscreenCanvas(THUMB_W, THUMB_H);
                    const ctx = canvas.getContext("2d")!;
                    ctx.drawImage(frame, 0, 0, THUMB_W, THUMB_H);
                    frame.close();
                    done = true; try { dec.close(); } catch { /* */ }
                    canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 })
                        .then((b: Blob) => b.arrayBuffer())
                        .then((ab: ArrayBuffer) => resolve(new Uint8Array(ab)))
                        .catch(reject);
                } catch (err) { finish(err); }
            },
            error: (e: any) => finish(e),
        });
        try {
            dec.configure({ codec, optimizeForLatency: true });
            dec.decode(new W.EncodedVideoChunk({ type: "key", timestamp: 0, data }));
            dec.flush().catch(() => { /* output already handled / errored */ });
        } catch (e) { finish(e); }
        setTimeout(() => finish(new Error("decode timeout")), 5000);
    });
}

// Reactive reader: blob URL for a region's keyframe thumbnail (undefined while loading).
export const getThumbUrl = asyncCache(async ({ level, t }: { level: number; t: number }): Promise<string> => {
    const key = `${level}:${Math.round(t)}`;
    try {
        let jpeg = await thumbDb.getSingleField(key, "jpeg");
        if (!jpeg) {
            if (!api) return "";
            const t0 = performance.now();
            const bytes = await api.getGopBytesAt(level, t);
            if (!bytes || !bytes.length) return "";
            jpeg = await decodeKeyframe(bytes);
            console.log(`[thumb] decoded L${level} t=${Math.round(t)} ${(performance.now() - t0).toFixed(0)}ms`);
            void thumbDb.write({ key, jpeg });
        }
        return URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
    } catch (e) {
        console.warn("[thumb] failed", level, Math.round(t), e);
        return ""; // never throw — asyncCache caches errors permanently
    }
});
