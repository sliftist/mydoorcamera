// Client-side thumbnails for activity regions.
//   getThumbUrl({level, t})  -- read inside @observer render(); returns a blob URL
//   for the most-active frame of the GOP at (level, t), or undefined while loading.
//
// We decode the WHOLE GOP (it's cheap) and pick the frame with the most motion — the
// largest frame-to-frame pixel difference — rather than just the keyframe, so the thumbnail
// shows the actual moment of activity. (The index only stores a per-GOP aMax, not which
// frame, so we recover the peak frame here.)
//
// Pipeline: asyncCache (in-memory, mobx-reactive) wraps a producer that first checks a
// persistent BulkDatabase2 cache of JPEG bytes; on a miss it fetches the GOP bytes (server
// RPC), decodes + picks the peak frame to a small JPEG, persists it, and returns a blob URL.

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

// Decode every frame of a GOP and return a small JPEG of the most-active one (the frame
// whose pixels differ most from the previous frame). Each VideoFrame is drawn then closed
// immediately, so the hardware decoder's surface pool never fills.
function decodePeakFrame(bytes: Uint8Array): Promise<Uint8Array> {
    const W: any = window as any;
    if (typeof W.VideoDecoder !== "function") return Promise.reject(new Error("no WebCodecs"));
    const { nals, units } = accessUnitsFromGop(Buffer.from(bytes));
    if (!units.length) return Promise.reject(new Error("no frames"));
    const codec = codecFromSps(nals);
    return new Promise<Uint8Array>((resolve, reject) => {
        const canvas = new OffscreenCanvas(THUMB_W, THUMB_H);
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        let prev: Uint8ClampedArray | null = null;
        let best: ImageData | null = null;
        let bestDiff = -1;
        let processed = 0;
        let done = false;
        const finish = (e?: any) => {
            if (done) return; done = true;
            try { dec.close(); } catch { /* */ }
            if (e || !best) { reject(e || new Error("no frame")); return; }
            ctx.putImageData(best, 0, 0);
            canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 })
                .then((b: Blob) => b.arrayBuffer())
                .then((ab: ArrayBuffer) => resolve(new Uint8Array(ab)))
                .catch(reject);
        };
        const dec = new W.VideoDecoder({
            output: (frame: any) => {
                if (done) { try { frame.close(); } catch { /* */ } return; }
                try {
                    ctx.drawImage(frame, 0, 0, THUMB_W, THUMB_H);
                    frame.close();
                    const img = ctx.getImageData(0, 0, THUMB_W, THUMB_H);
                    const cur = img.data;
                    let diff = 0;
                    if (prev) for (let i = 0; i < cur.length; i += 4) diff += Math.abs(cur[i] - prev[i]) + Math.abs(cur[i + 1] - prev[i + 1]) + Math.abs(cur[i + 2] - prev[i + 2]);
                    if (diff > bestDiff) { bestDiff = diff; best = img; } // first frame (diff 0) is the fallback
                    prev = cur;
                    if (++processed >= units.length) finish();
                } catch (err) { finish(err); }
            },
            error: (e: any) => finish(e),
        });
        try {
            dec.configure({ codec, optimizeForLatency: true });
            for (let i = 0; i < units.length; i++) dec.decode(new W.EncodedVideoChunk({ type: units[i].key ? "key" : "delta", timestamp: i, data: units[i].data }));
            dec.flush().then(() => finish()).catch(() => finish());
        } catch (e) { finish(e); }
        setTimeout(() => finish(new Error("decode timeout")), 8000);
    });
}

// Reactive reader: blob URL for a region's keyframe thumbnail (undefined while loading).
export const getThumbUrl = asyncCache(async ({ level, t }: { level: number; t: number }): Promise<string> => {
    const key = `peak:${level}:${Math.round(t)}`; // "peak:" prefix invalidates old keyframe-only thumbnails
    try {
        let jpeg = await thumbDb.getSingleField(key, "jpeg");
        if (!jpeg) {
            if (!api) return "";
            const t0 = performance.now();
            const bytes = await api.getGopBytesAt(level, t);
            if (!bytes || !bytes.length) return "";
            jpeg = await decodePeakFrame(bytes);
            console.log(`[thumb] peak frame L${level} t=${Math.round(t)} ${(performance.now() - t0).toFixed(0)}ms`);
            void thumbDb.write({ key, jpeg });
        }
        return URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
    } catch (e) {
        console.warn("[thumb] failed", level, Math.round(t), e);
        return ""; // never throw — asyncCache caches errors permanently
    }
});
