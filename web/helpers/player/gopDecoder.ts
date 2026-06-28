// DECODE — shared by the renderer (live, on a cache miss) and the pre-buffer (ahead of
// time). Wraps one WebCodecs VideoDecoder. Decodes a WHOLE GOP at a time (≈30 frames),
// which keeps the decoder's in-order pipeline trivial: feed SPS/PPS/IDR + deltas, flush,
// done. Every decoded frame is routed (by its timestamp = footage wall) straight into the
// shared FrameCache, so callers never handle frames directly.
//
// ensureGop()/ensureWall() are deduped (a GOP already cached or in flight isn't re-fed)
// and serialized (feeds never interleave, which would corrupt reference frames).

import { GopEntry, Decoded, W } from "./types";
import { GopSource } from "./gopSource";
import { FrameCache } from "./frameCache";
import { accessUnitsFromGop, codecFromSps } from "../h264";
import { FPS } from "../../../src/config";

export class GopDecoder {
    private decoder: any | undefined;     // VideoDecoder
    private codec = "";
    private configured = false;
    private inFlight = new Map<number, Promise<void>>();
    private feedChain: Promise<void> = Promise.resolve();
    private destroyed = false;

    constructor(private source: GopSource, private cache: FrameCache) {}

    // Decode the GOP at-or-before `wall` (resolves the index first). Fire-and-forget safe.
    async ensureWall(wall: number, priority: boolean): Promise<void> {
        const g = await this.source.gopForWall(wall);
        if (g) await this.ensureGop(g, priority);
    }

    // Decode `gop` into the FrameCache (deduped + serialized). Resolves when its frames
    // are in the cache (or immediately if already there / in flight).
    ensureGop(gop: GopEntry, priority: boolean): Promise<void> {
        if (this.destroyed) return Promise.resolve();
        if (this.cache.has(gop.t, this.source.frameStep)) return Promise.resolve(); // first frame already decoded
        const ex = this.inFlight.get(gop.t);
        if (ex) return ex;
        const p = this.run(gop, priority).finally(() => { this.inFlight.delete(gop.t); });
        this.inFlight.set(gop.t, p);
        return p;
    }

    private async run(gop: GopEntry, priority: boolean): Promise<void> {
        let data: Buffer;
        try { data = await this.source.getBytes(gop, priority); }
        catch { return; } // fetch cancelled/failed — caller retries later
        if (this.destroyed) return;
        // Serialize the actual feed+flush so two GOPs never interleave in the decoder.
        this.feedChain = this.feedChain.then(() => this.feed(gop, data)).catch(() => { /* */ });
        await this.feedChain;
    }

    private ensureDecoder(codec: string): void {
        if (typeof W.VideoDecoder !== "function") return;
        if (this.decoder && this.codec === codec) return;
        if (this.decoder) { try { this.decoder.close(); } catch { /* */ } }
        this.codec = codec;
        this.configured = false;
        this.decoder = new W.VideoDecoder({
            output: (frame: any) => {
                if (this.destroyed) { try { frame.close(); } catch { /* */ } return; }
                this.cache.putFrames([{ wall: frame.timestamp / 1000, frame } as Decoded]);
            },
            error: (e: any) => { console.warn("[decoder] error", e?.message || e); this.configured = false; },
        });
    }

    private async feed(gop: GopEntry, data: Buffer): Promise<void> {
        if (this.destroyed) return;
        const { nals, units } = accessUnitsFromGop(data);
        if (!units.length) return;
        this.ensureDecoder(codecFromSps(nals));
        if (!this.decoder) return;
        if (!this.configured) { try { this.decoder.configure({ codec: this.codec, optimizeForLatency: true }); this.configured = true; } catch (e) { console.warn("[decoder] configure failed", e); return; } }
        const walls = this.source.frameWalls(gop, units.length);
        for (let i = 0; i < units.length; i++) {
            try { this.decoder.decode(new W.EncodedVideoChunk({ type: units[i].key ? "key" : "delta", timestamp: Math.round(walls[i] * 1000), data: units[i].data })); }
            catch (e) { console.warn("[decoder] decode failed", e); return; }
        }
        try { await this.decoder.flush(); } catch { /* reset mid-flush */ }
    }

    // Drop the decoder's queued work (on a seek) so the new target decodes immediately.
    reset(): void {
        if (this.decoder) { try { this.decoder.reset(); } catch { /* */ } }
        this.configured = false;
        this.feedChain = Promise.resolve();
        this.inFlight.clear();
    }

    // ---- live ----
    feedLive(meta: { t: number; e: number; n: number }, bytes: Uint8Array): void {
        if (this.destroyed) return;
        this.feedChain = this.feedChain.then(() => this.doFeedLive(meta, bytes)).catch(() => { /* */ });
    }
    private async doFeedLive(meta: { t: number; e: number; n: number }, bytes: Uint8Array): Promise<void> {
        if (this.destroyed) return;
        const { nals, units } = accessUnitsFromGop(Buffer.from(bytes));
        if (!units.length) return;
        this.ensureDecoder(codecFromSps(nals));
        if (!this.decoder) return;
        if (!this.configured) { try { this.decoder.configure({ codec: this.codec, optimizeForLatency: true }); this.configured = true; } catch { return; } }
        const span = meta.n > 0 ? (meta.e - meta.t) / meta.n : 1000 / FPS;
        for (let i = 0; i < units.length; i++) {
            const wall = meta.t + i * (span > 0 ? span : 1000 / FPS);
            try { this.decoder.decode(new W.EncodedVideoChunk({ type: units[i].key ? "key" : "delta", timestamp: Math.round(wall * 1000), data: units[i].data })); }
            catch { return; }
        }
    }

    dispose(): void {
        this.destroyed = true;
        if (this.decoder) { try { this.decoder.close(); } catch { /* */ } this.decoder = undefined; }
        this.configured = false; this.inFlight.clear();
    }
}
