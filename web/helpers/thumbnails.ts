// Client-side keyframe thumbnails for activity regions.
//   getThumbUrl({level, t})  -- read inside @observer render(); returns a blob URL
//   for the decoded keyframe of the GOP at (level, t), or undefined while loading.
//
// Pipeline: asyncCache (in-memory, mobx-reactive) wraps a producer that first checks
// a persistent BulkDatabase2 cache of JPEG bytes; on a miss it fetches the GOP bytes
// (server RPC), decodes the keyframe with WebCodecs to a small JPEG, persists it, and
// returns a blob URL. Decode time is logged so cache hits/misses are visible.

import { asyncCache } from "sliftutils/render-utils/asyncObservable";
import { BulkDatabase2, IBulkDatabase2 } from "sliftutils/storage/BulkDatabase2/BulkDatabase2";
import { accessUnitsFromGop, codecFromSps } from "./h264";
import { api } from "./session";

const THUMB_W = 256, THUMB_H = 144;
// NOTE: typed via the IBulkDatabase2 interface. The concrete BulkDatabase2 class
// extends BulkDatabaseBase through a circular re-export, which makes TS collapse
// the derived instance type to {} (all methods vanish) — so we view it through
// the interface, which carries the real surface. Runtime is unaffected.
type ThumbRow = { key: string; jpeg: Uint8Array };
const thumbDb = new BulkDatabase2<ThumbRow>("activityThumbs") as unknown as IBulkDatabase2<ThumbRow>;

// Decode the SPS+PPS+IDR of a GOP to a small JPEG via WebCodecs (Annex-B).
function decodeKeyframe(bytes: Uint8Array): Promise<Uint8Array> {
    const W: any = window as any;
    if (typeof W.VideoDecoder !== "function") return Promise.reject(new Error("no WebCodecs"));
    const { nals, units } = accessUnitsFromGop(Buffer.from(bytes));
    const key = units.find(u => u.key);
    if (!key) return Promise.reject(new Error("no keyframe"));
    const data = key.data;
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
