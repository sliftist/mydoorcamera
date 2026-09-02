// LIVE-path GOP decode — decode one arriving GOP into ImageBitmaps (presentation order).
// Only LivePlayer uses this: its playout queue holds ~1.5s of frames, far more than the
// hardware decoder's output-surface pool allows as live VideoFrames, so each frame is
// copied to an ImageBitmap and its VideoFrame closed right away (freeing the surface —
// which also lets the decode finish). REVIEW playback does NOT go through here anymore;
// it streams live VideoFrames incrementally via frameStream.ts.

import { clockHMS } from "../format";
import { accessUnitsFromGop, codecFromSps } from "../h264";

const MAX_FRAME_WIDTH = 1280; // downscale bitmaps to ~720p to bound memory

// ---- ONE shared decoder, fed one GOP at a time ----
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
        error: e => { console.warn("[live-decode] decoder error", (e as any)?.message || e); try { decoder?.close(); } catch { /* */ } decoder = undefined; },
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
    try { ensureDecoder(codecFromSps(nals)); } catch (e) { console.warn("[live-decode] configure failed", e); return []; }
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
        console.warn("[live-decode] failed", e);
    }
    await Promise.all(tasks); // wait for bitmap copies (and the frame closes)
    collect = null;
    if (!flushed && decoder && decoder.state !== "closed") { try { decoder.close(); } catch { /* */ } decoder = undefined; } // hung -> rebuild
    made.sort((a, b) => a.ts - b.ts);
    console.log(`[live-decode] ${made.length}f in ${Date.now() - t0}ms @ ${clockHMS(walls[0] ?? 0)}`);
    return made.map(m => m.bmp);
}
