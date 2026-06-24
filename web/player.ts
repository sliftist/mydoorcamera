// MSE streaming player for one hour of footage. Each immutable GOP is muxed to a
// fragment with mp4-typescript and placed on a shared media timeline via
// mediaStartTimeSeconds = (gopTime - hourStart)/1000, so video.currentTime maps
// directly to wall-clock within the hour and seeking Just Works. GOPs are fetched
// and appended lazily as the playhead approaches them.

import { CameraApi, GopEntry } from "./api";
import { splitFramedNals } from "../src/annexb";
import { H264toMP4 } from "mp4-typescript";
import { FPS } from "../src/config";

function codecFromSps(nals: Buffer[]): string {
    const sps = nals.find(n => (n[0] & 0x1f) === 7);
    if (!sps || sps.length < 4) return "avc1.4D0028"; // main@4.0 fallback
    const hex = (b: number) => b.toString(16).padStart(2, "0");
    return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

export class Player {
    private ms: MediaSource | undefined;
    private sb: SourceBuffer | undefined;
    private appended = new Set<number>();   // GOP indices already in the SourceBuffer
    private queue: Buffer[] = [];            // append serialization (one at a time)
    private flushing = false;
    readonly hourStart: number;
    readonly hourEnd: number;

    constructor(public video: HTMLVideoElement, public api: CameraApi, public parts: string[], public gops: GopEntry[]) {
        this.hourStart = gops.length ? gops[0].t : 0;
        const last = gops[gops.length - 1];
        this.hourEnd = last ? last.t + Math.round((last.n / FPS) * 1000) : this.hourStart;
    }

    durationSec(): number { return (this.hourEnd - this.hourStart) / 1000; }
    private internalSec(wallMs: number): number { return (wallMs - this.hourStart) / 1000; }

    // Index of the last GOP whose keyframe time is <= wallMs (binary search).
    private findGopIdx(wallMs: number): number {
        let lo = 0, hi = this.gops.length - 1, res = 0;
        while (lo <= hi) {
            const m = (lo + hi) >> 1;
            if (this.gops[m].t <= wallMs) { res = m; lo = m + 1; } else hi = m - 1;
        }
        return res;
    }

    private async fetchNals(idx: number): Promise<Buffer[]> {
        const g = this.gops[idx];
        const data = await this.api.getGopData(this.parts, g.f, g.o, g.l);
        return splitFramedNals(Buffer.from(data));
    }

    private enqueue(buf: Buffer): void { this.queue.push(buf); this.flushQueue(); }
    private flushQueue(): void {
        if (this.flushing || !this.sb || this.sb.updating || !this.queue.length) return;
        this.flushing = true;
        const buf = this.queue.shift()!;
        const done = () => { this.sb!.removeEventListener("updateend", done); this.flushing = false; this.flushQueue(); };
        this.sb.addEventListener("updateend", done);
        try { this.sb.appendBuffer(buf as any); } catch { this.flushing = false; }
    }

    private async appendGop(idx: number, nals?: Buffer[]): Promise<void> {
        if (idx < 0 || idx >= this.gops.length || this.appended.has(idx)) return;
        this.appended.add(idx);
        const ns = nals || await this.fetchNals(idx);
        const g = this.gops[idx];
        const mp4 = await H264toMP4({ buffer: ns, frameDurationInSeconds: 1 / FPS, mediaStartTimeSeconds: this.internalSec(g.t) });
        this.enqueue(Buffer.from(mp4.buffer));
    }

    private async ensureStarted(idx: number): Promise<void> {
        if (this.sb) return;
        this.ms = new MediaSource();
        this.video.src = URL.createObjectURL(this.ms);
        await new Promise<void>(res => this.ms!.addEventListener("sourceopen", () => res(), { once: true }));
        const nals = await this.fetchNals(idx);
        this.sb = this.ms.addSourceBuffer(`video/mp4; codecs="${codecFromSps(nals)}"`);
        await this.appendGop(idx, nals);
        this.video.addEventListener("timeupdate", () => this.bufferAhead());
    }

    // Seek to a wall-clock time within the hour, decoding from the covering keyframe.
    async seek(wallMs: number): Promise<void> {
        if (!this.gops.length) return;
        const idx = this.findGopIdx(wallMs);
        await this.ensureStarted(idx);
        await this.loadRange(this.gops[idx].t, this.gops[idx].t + 10_000); // ~10s ahead
        this.video.currentTime = this.internalSec(this.gops[idx].t);
        this.video.play().catch(() => { /* autoplay may be blocked until user gesture */ });
    }

    // The time-range helper: ensure all GOPs covering [startWallMs, endWallMs] are
    // fetched, muxed, and appended (decodes from the keyframe at/just-before start).
    async loadRange(startWallMs: number, endWallMs: number): Promise<void> {
        let i = this.findGopIdx(startWallMs);
        for (; i < this.gops.length && this.gops[i].t <= endWallMs; i++) {
            if (!this.appended.has(i)) await this.appendGop(i);
        }
    }

    private bufferAhead(): void {
        const headWall = this.hourStart + this.video.currentTime * 1000;
        void this.loadRange(headWall, headWall + 15_000); // keep ~15s buffered ahead
    }

    teardown(): void {
        try { this.video.pause(); this.video.removeAttribute("src"); this.video.load(); } catch { /* ignore */ }
        this.ms = undefined; this.sb = undefined;
        this.appended.clear(); this.queue = []; this.flushing = false;
    }
}
