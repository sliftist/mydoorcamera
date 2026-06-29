// LIVE player — separate from the review DayPlayer. Plays the live stream SMOOTHLY: each arriving
// GOP is decoded to all its frames, which are queued and rendered at real-time cadence (not just
// the newest frame — that made live look like ~1 fps bursts). If frames arrive faster than they can
// be shown (we're falling behind), the OLDEST queued frames are dropped to stay live, and the drop
// is counted so we can report how much the live rate had to degrade.

import { CameraApi } from "../api";
import { FPS } from "../../../src/config";
import { Renderer } from "./renderer";
import { decodeGop } from "./frameCache";

type LiveGop = { meta: { t: number; e: number; n: number }; bytes: Uint8Array };

const CADENCE_MS = 1000 / FPS;     // target gap between rendered frames
const MAX_QUEUE = Math.round(FPS * 1.5); // ~1.5s of playout buffer; beyond this we're behind -> drop oldest

export class LivePlayer {
    private queue: { bmp: ImageBitmap; wall: number }[] = [];
    private pending: LiveGop | null = null;
    private decoding = false;
    private stopped = false;
    private rafId: number | undefined;
    private lastRenderAt = 0;
    private rendered = 0;
    private dropped = 0;

    constructor(private renderer: Renderer, private api: CameraApi, private dayParts: string[]) {}

    async start(): Promise<void> {
        this.stopped = false;
        if (typeof requestAnimationFrame !== "undefined") this.rafId = requestAnimationFrame(this.tick);
        await this.api.startStream(this.dayParts.join("/"), (meta, bytes) => this.onData(meta, bytes));
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.pending = null;
        if (this.rafId != null && typeof cancelAnimationFrame !== "undefined") { try { cancelAnimationFrame(this.rafId); } catch { /* */ } }
        this.rafId = undefined;
        for (const f of this.queue) { try { f.bmp.close(); } catch { /* */ } }
        this.queue = [];
        try { await this.api.stopStream(); } catch { /* */ }
    }

    // How much the live rate is degrading: fraction of frames dropped because we couldn't keep up.
    get liveStats(): { rendered: number; dropped: number } { return { rendered: this.rendered, dropped: this.dropped }; }

    private onData(meta: { t: number; e: number; n: number }, bytes: Uint8Array): void {
        if (this.stopped) return;
        this.pending = { meta, bytes }; // newest unprocessed GOP wins if decode is busy
        void this.drain();
    }

    private async drain(): Promise<void> {
        if (this.decoding) return;
        this.decoding = true;
        try {
            while (this.pending && !this.stopped) {
                const { meta, bytes } = this.pending;
                this.pending = null;
                const span = meta.n > 0 ? (meta.e - meta.t) / meta.n : CADENCE_MS;
                const walls: number[] = [];
                for (let i = 0; i < Math.max(meta.n, 1); i++) walls.push(meta.t + i * (span > 0 ? span : CADENCE_MS));
                let bitmaps: ImageBitmap[];
                try { bitmaps = await decodeGop(Buffer.from(bytes), walls); }
                catch { continue; }
                for (let i = 0; i < bitmaps.length; i++) this.queue.push({ bmp: bitmaps[i], wall: walls[i] ?? meta.t });
                // Bounded playout buffer: if we're behind, drop the OLDEST frames to stay live.
                if (this.queue.length > MAX_QUEUE) {
                    const drop = this.queue.splice(0, this.queue.length - MAX_QUEUE);
                    for (const f of drop) { try { f.bmp.close(); } catch { /* */ } }
                    this.dropped += drop.length;
                }
            }
        } finally {
            this.decoding = false;
        }
    }

    // Render at most one queued frame per cadence tick (smooth ~FPS playout).
    private tick = (): void => {
        if (this.stopped) return;
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (this.queue.length && now - this.lastRenderAt >= CADENCE_MS) {
            const f = this.queue.shift()!;
            this.renderer.drawImage(f.bmp, f.wall);
            try { f.bmp.close(); } catch { /* */ }
            this.lastRenderAt = now;
            this.rendered++;
        }
        this.rafId = requestAnimationFrame(this.tick);
    };
}
