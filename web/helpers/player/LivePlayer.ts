// LIVE player — entirely separate from the review DayPlayer. It just renders the most
// recently received GOP, dropping any intermediate data. No clock, no seeking.
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

    constructor(private renderer: Renderer, private api: CameraApi, private dayParts: string[]) {}

    async start(): Promise<void> {
        this.stopped = false;
        await this.api.startStream(this.dayParts.join("/"), (meta, bytes) => this.onData(meta, bytes));
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.pending = null;
        try { await this.api.stopStream(); } catch { /* */ }
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
                let bitmaps: ImageBitmap[];
                try { bitmaps = await decodeGop(Buffer.from(bytes), walls); }
                catch { continue; }
                const newest = bitmaps[bitmaps.length - 1];
                if (newest && !this.stopped) this.renderer.drawImage(newest, walls[bitmaps.length - 1] ?? meta.t);
                for (const b of bitmaps) { try { b.close(); } catch { /* */ } } // copy is done at draw; free them
            }
        } finally {
            this.decoding = false;
        }
    }
}
