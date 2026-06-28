// LIVE player — entirely separate from the review DayPlayer. It just renders the most
// recently received GOP, dropping any intermediate data. There is no clock and no seeking:
// frames arrive from the stream, we decode the newest and show its last frame.
//
// Keeping-up smartness: while a decode is in flight we only retain the LATEST arrival
// (`pending` is overwritten), so if decoding can't keep pace with the stream we naturally
// skip whole GOPs instead of falling behind.

import { CameraApi } from "../api";
import { FPS } from "../../../src/config";
import { Renderer } from "./renderer";
import { decodeGop } from "./frameCache";

type LiveGop = { meta: { t: number; e: number; n: number }; bytes: Uint8Array };

export class LivePlayer {
    private pending: LiveGop | null = null;
    private decoding = false;
    private stopped = false;
    private shown: VideoFrame | null = null; // currently displayed frame (kept alive until replaced)

    constructor(private renderer: Renderer, private api: CameraApi, private dayParts: string[]) {}

    async start(): Promise<void> {
        this.stopped = false;
        await this.api.startStream(this.dayParts.join("/"), (meta, bytes) => this.onData(meta, bytes));
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.pending = null;
        try { await this.api.stopStream(); } catch { /* */ }
        if (this.shown) { try { this.shown.close(); } catch { /* */ } this.shown = null; }
    }

    // Newest data wins — overwrite any not-yet-decoded arrival, then kick the decode loop.
    private onData(meta: { t: number; e: number; n: number }, bytes: Uint8Array): void {
        if (this.stopped) return;
        this.pending = { meta, bytes };
        void this.drain();
    }

    private async drain(): Promise<void> {
        if (this.decoding) return;
        this.decoding = true;
        try {
            while (this.pending && !this.stopped) {
                const { meta, bytes } = this.pending;
                this.pending = null; // anything that arrives during decode replaces this
                const span = meta.n > 0 ? (meta.e - meta.t) / meta.n : 1000 / FPS;
                const walls: number[] = [];
                for (let i = 0; i < Math.max(meta.n, 1); i++) walls.push(meta.t + i * (span > 0 ? span : 1000 / FPS));
                let frames: VideoFrame[];
                try { frames = await decodeGop(Buffer.from(bytes), walls); }
                catch { continue; }
                const newest = frames.pop();
                for (const f of frames) { try { f.close(); } catch { /* */ } } // we only show the newest
                if (!newest) continue;
                if (this.stopped) { try { newest.close(); } catch { /* */ } break; }
                this.renderer.drawFrame(newest);
                if (this.shown) { try { this.shown.close(); } catch { /* */ } } // keep newest alive until next draw
                this.shown = newest;
            }
        } finally {
            this.decoding = false;
        }
    }
}
