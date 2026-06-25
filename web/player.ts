// Day-based MSE streaming player. The media timeline spans the whole day
// (video.currentTime = seconds since the day's local midnight), so the trackbar
// can scrub anywhere in the day. GOP indexes are loaded lazily per hour and
// GOPs are fetched/muxed/appended in a window around the playhead, across hour
// boundaries. Old buffer behind the playhead is evicted to stay under quota.

import { CameraApi, GopEntry } from "./api";
import { splitFramedNals } from "../src/annexb";
import { H264toMP4 } from "mp4-typescript";
import { FPS } from "../src/config";

function codecFromSps(nals: Buffer[]): string {
    const sps = nals.find(n => (n[0] & 0x1f) === 7);
    if (!sps || sps.length < 4) return "avc1.4D0028";
    const hex = (b: number) => b.toString(16).padStart(2, "0");
    return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}
function pad2(n: number): string { return String(n).padStart(2, "0"); }

export class DayPlayer {
    private ms: MediaSource | undefined;
    private sb: SourceBuffer | undefined;
    private appended = new Set<number>();          // gop.t values already in the buffer
    private queue: Buffer[] = [];
    private flushing = false;
    private hourCache = new Map<string, GopEntry[]>();
    onTime: ((wallMs: number) => void) | undefined;

    constructor(public video: HTMLVideoElement, public api: CameraApi, public dayParts: string[], public dayStartMs: number) {
        this.video.addEventListener("timeupdate", this.onTimeUpdate);
    }

    private onTimeUpdate = (): void => {
        const wall = this.dayStartMs + this.video.currentTime * 1000;
        this.onTime?.(wall);
        void this.loadRange(wall, wall + 15_000).catch(() => { /* ignore */ });
        this.evictBefore(this.video.currentTime - 90);
    };

    internalSec(wallMs: number): number { return (wallMs - this.dayStartMs) / 1000; }
    private hourNumOf(wallMs: number): number { return Math.floor((wallMs - this.dayStartMs) / 3600_000); }
    private gopDurMs(g: GopEntry): number { return Math.round((g.n / FPS) * 1000); }

    private async ensureHour(hourNum: number): Promise<GopEntry[]> {
        if (hourNum < 0 || hourNum > 23) return [];
        const hh = pad2(hourNum);
        if (!this.hourCache.has(hh)) {
            try { this.hourCache.set(hh, await this.api.getHourIndex([...this.dayParts, hh])); }
            catch { return []; } // don't cache a failure (e.g. during a reconnect) — retry later
        }
        return this.hourCache.get(hh) || [];
    }

    // The GOP covering wallMs (last keyframe at/before it), else the nearest after.
    private async gopAt(wallMs: number): Promise<{ hh: string; g: GopEntry } | undefined> {
        const base = this.hourNumOf(wallMs);
        for (let hn = base; hn >= Math.max(0, base - 3); hn--) {
            const gops = await this.ensureHour(hn);
            let found: GopEntry | undefined;
            for (const g of gops) { if (g.t <= wallMs) found = g; else break; }
            if (found) return { hh: pad2(hn), g: found };
        }
        for (let hn = base; hn <= Math.min(23, base + 3); hn++) {
            const gops = await this.ensureHour(hn);
            if (gops.length) return { hh: pad2(hn), g: gops[0] };
        }
        return undefined;
    }

    private async fetchNals(hh: string, g: GopEntry): Promise<Buffer[]> {
        const data = await this.api.getGopData([...this.dayParts, hh], g.f, g.o, g.l);
        return splitFramedNals(Buffer.from(data));
    }

    private enqueue(buf: Buffer): void { this.queue.push(buf); this.flush(); }
    private flush(): void {
        if (this.flushing || !this.sb || this.sb.updating || !this.queue.length) return;
        this.flushing = true;
        const buf = this.queue.shift()!;
        const done = () => { this.sb!.removeEventListener("updateend", done); this.flushing = false; this.flush(); };
        this.sb.addEventListener("updateend", done);
        try { this.sb.appendBuffer(buf as any); } catch { this.flushing = false; }
    }

    private async appendGop(hh: string, g: GopEntry, nals?: Buffer[]): Promise<void> {
        if (this.appended.has(g.t)) return;
        this.appended.add(g.t);
        try {
            const ns = nals || await this.fetchNals(hh, g);
            const mp4 = await H264toMP4({ buffer: ns, frameDurationInSeconds: 1 / FPS, mediaStartTimeSeconds: this.internalSec(g.t) });
            this.enqueue(Buffer.from(mp4.buffer));
        } catch (e) {
            this.appended.delete(g.t); // a fetch failed (e.g. during a reconnect) — allow a later retry
            throw e;
        }
    }

    // Seek to a wall-clock time in the day and start playing from the covering keyframe.
    async seek(wallMs: number): Promise<void> {
        const target = await this.gopAt(wallMs);
        if (!target) return;
        const nals = await this.fetchNals(target.hh, target.g);
        if (!this.sb) {
            this.ms = new MediaSource();
            this.video.src = URL.createObjectURL(this.ms);
            await new Promise<void>(res => this.ms!.addEventListener("sourceopen", () => res(), { once: true }));
            this.sb = this.ms.addSourceBuffer(`video/mp4; codecs="${codecFromSps(nals)}"`);
        }
        await this.appendGop(target.hh, target.g, nals);
        await this.loadRange(target.g.t, target.g.t + 10_000);
        this.video.currentTime = this.internalSec(target.g.t);
        this.video.play().catch(() => { /* gesture may be required */ });
    }

    // Ensure all GOPs covering [startWall, endWall] are fetched + appended.
    async loadRange(startWall: number, endWall: number): Promise<void> {
        for (let hn = this.hourNumOf(startWall); hn <= 23 && (this.dayStartMs + hn * 3600_000) <= endWall; hn++) {
            const hh = pad2(hn);
            const gops = await this.ensureHour(hn);
            for (const g of gops) {
                if (g.t + this.gopDurMs(g) < startWall) continue;
                if (g.t > endWall) return;
                if (!this.appended.has(g.t)) {
                    try { await this.appendGop(hh, g); } catch { return; } // drop/fetch error — stop, retry later
                }
            }
        }
    }

    private evictBefore(sec: number): void {
        if (!this.sb || this.sb.updating || this.queue.length || sec <= 0) return;
        try {
            if (this.sb.buffered.length && this.sb.buffered.start(0) < sec - 5) this.sb.remove(0, sec);
        } catch { /* ignore */ }
    }

    teardown(): void {
        this.video.removeEventListener("timeupdate", this.onTimeUpdate);
        try { this.video.pause(); this.video.removeAttribute("src"); this.video.load(); } catch { /* ignore */ }
        this.ms = undefined; this.sb = undefined;
        this.appended.clear(); this.queue = []; this.flushing = false; this.hourCache.clear();
    }
}
