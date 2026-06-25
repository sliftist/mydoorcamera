// Day-based MSE player that we fully drive (no native controls). Key behaviours:
//  - 4-state status: playing | paused | waiting (want to play, fetching) |
//    unavailable (want to play but there's no footage here).
//  - Seeking runs a single "pump" that renders ONE frame before chasing the
//    next target, always jumping to the latest desired position. Only one GOP
//    fetch is ever in flight, so fast scrubbing / held arrow keys never pile up
//    requests — they just show frames a little slower.
//  - During scrub the video is paused (static frames); when scrubbing settles
//    and the user wants to play, normal windowed buffering + playback resume.

import { CameraApi, GopEntry } from "./api";
import { splitFramedNals } from "../src/annexb";
import { H264toMP4 } from "mp4-typescript";
import { FPS } from "../src/config";

export type PlayStatus = "playing" | "paused" | "waiting" | "unavailable";

function codecFromSps(nals: Buffer[]): string {
    const sps = nals.find(n => (n[0] & 0x1f) === 7);
    if (!sps || sps.length < 4) return "avc1.4D0028";
    const hex = (b: number) => b.toString(16).padStart(2, "0");
    return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}
function pad2(n: number): string { return String(n).padStart(2, "0"); }
const DAY_MS = 24 * 3600 * 1000;
const PREBUFFER_MS = 4000; // buffer this much ahead after a seek so play is instant (LAN server)

export class DayPlayer {
    private ms: MediaSource | undefined;
    private sb: SourceBuffer | undefined;
    private appended = new Set<number>();
    private queue: { buf: Buffer; resolve: () => void }[] = [];
    private flushing = false;
    private hourCache = new Map<string, GopEntry[]>();

    private intent: "play" | "pause" = "pause";
    private targetWall: number;
    private shownWall = -1;
    private pumping = false;
    private status: PlayStatus = "paused";

    onStatus: ((s: PlayStatus) => void) | undefined;
    onTime: ((wallMs: number) => void) | undefined;

    constructor(
        public video: HTMLVideoElement,
        public api: CameraApi,
        public dayParts: string[],
        public dayStartMs: number,
        public ranges: { start: number; end: number }[],
    ) {
        this.targetWall = dayStartMs;
        this.video.addEventListener("timeupdate", this.onTimeUpdate);
        for (const ev of ["playing", "waiting", "pause", "seeked", "ended", "stalled", "canplay"]) {
            this.video.addEventListener(ev, this.refreshStatus);
        }
    }

    // ---- helpers ----
    internalSec(wall: number): number { return (wall - this.dayStartMs) / 1000; }
    currentWall(): number { return this.dayStartMs + this.video.currentTime * 1000; }
    private hourNumOf(wall: number): number { return Math.floor((wall - this.dayStartMs) / 3600_000); }
    private gopDurMs(g: GopEntry): number { return Math.round((g.n / FPS) * 1000); }
    private coveredAt(wall: number): boolean { return this.ranges.some(r => wall >= r.start && wall <= r.end + 500); }

    get playStatus(): PlayStatus { return this.status; }
    get wantsPlay(): boolean { return this.intent === "play"; }

    // ---- intent ----
    togglePlay(): void { if (this.intent === "play") this.pause(); else this.play(); }
    play(): void { this.intent = "play"; this.refreshStatus(); void this.startPlaybackFrom(this.currentWall()); }
    pause(): void { this.intent = "pause"; try { this.video.pause(); } catch { /* */ } this.refreshStatus(); }

    // ---- seeking (click / drag / arrows) ----
    seekTo(wall: number): void {
        this.targetWall = Math.max(this.dayStartMs, Math.min(this.dayStartMs + DAY_MS - 1, wall));
        try { this.video.pause(); } catch { /* */ }   // static frames while seeking
        this.refreshStatus();
        void this.runSeekPump();
    }
    nudge(deltaMs: number): void { this.seekTo((this.targetWall >= 0 ? this.targetWall : this.currentWall()) + deltaMs); }
    seekTarget(): number { return this.targetWall; }

    private async runSeekPump(): Promise<void> {
        if (this.pumping) return;
        this.pumping = true;
        try {
            while (this.shownWall !== this.targetWall) {
                const t = this.targetWall;        // always chase the latest
                await this.showFrameAt(t);
                this.shownWall = t;
            }
        } finally {
            this.pumping = false;
        }
        // Settled on a target. If playing, kick off normal windowed buffering +
        // playback; if paused, still prebuffer a few seconds so hitting play (or a
        // resume) starts immediately.
        if (this.intent === "play") void this.startPlaybackFrom(this.targetWall);
        else void this.loadRange(this.targetWall, this.targetWall + PREBUFFER_MS).catch(() => { /* */ });
    }

    private async showFrameAt(wall: number): Promise<void> {
        if (!this.coveredAt(wall)) { this.setStatus("unavailable"); return; }
        const target = await this.gopAt(wall);
        if (!target) { this.setStatus("unavailable"); return; }
        try {
            await this.ensureSourceBuffer(target);
            await this.appendGop(target.hh, target.g);
            await this.seekVideo(this.internalSec(Math.max(wall, target.g.t)));
            this.onTime?.(this.currentWall());
        } catch { /* fetch dropped — pump will retry to the latest target */ }
    }

    private seekVideo(sec: number): Promise<void> {
        return new Promise(res => {
            let done = false;
            const finish = () => { if (done) return; done = true; this.video.removeEventListener("seeked", finish); res(); };
            this.video.addEventListener("seeked", finish, { once: true });
            try { this.video.currentTime = sec; } catch { finish(); return; }
            setTimeout(finish, 400); // never hang if 'seeked' doesn't fire
        });
    }

    // ---- playback ----
    private async startPlaybackFrom(wall: number): Promise<void> {
        if (this.intent !== "play") return;
        if (!this.coveredAt(wall)) { this.setStatus("unavailable"); return; }
        const target = await this.gopAt(wall);
        if (!target) { this.setStatus("unavailable"); return; }
        await this.ensureSourceBuffer(target);
        await this.loadRange(wall, wall + 12_000).catch(() => { /* */ });
        if (this.intent !== "play") return;
        if (Math.abs(this.currentWall() - wall) > 1500) { try { this.video.currentTime = this.internalSec(wall); } catch { /* */ } }
        try { await this.video.play(); } catch { /* gesture needed */ }
        this.refreshStatus();
    }

    private onTimeUpdate = (): void => {
        const wall = this.currentWall();
        this.onTime?.(wall);
        if (this.intent === "play" && !this.video.paused && !this.pumping) {
            void this.loadRange(wall, wall + 15_000).catch(() => { /* */ });
            this.evictBefore(this.video.currentTime - 90);
        }
        this.refreshStatus();
    };

    private refreshStatus = (): void => {
        if (this.intent === "pause") { this.setStatus("paused"); return; }
        const wall = this.pumping ? this.targetWall : this.currentWall();
        if (!this.coveredAt(wall)) { this.setStatus("unavailable"); return; }
        if (!this.video.paused && this.video.readyState >= 3) { this.setStatus("playing"); return; }
        this.setStatus("waiting");
    };
    private setStatus(s: PlayStatus): void { if (s !== this.status) { this.status = s; this.onStatus?.(s); } }

    // ---- buffering primitives ----
    private async ensureSourceBuffer(target: { hh: string; g: GopEntry }): Promise<void> {
        if (this.sb) return;
        const nals = await this.fetchNals(target.hh, target.g);
        this.ms = new MediaSource();
        this.video.src = URL.createObjectURL(this.ms);
        await new Promise<void>(res => this.ms!.addEventListener("sourceopen", () => res(), { once: true }));
        this.sb = this.ms.addSourceBuffer(`video/mp4; codecs="${codecFromSps(nals)}"`);
        await this.appendGop(target.hh, target.g, nals);
    }

    private async ensureHour(hourNum: number): Promise<GopEntry[]> {
        if (hourNum < 0 || hourNum > 23) return [];
        const hh = pad2(hourNum);
        if (!this.hourCache.has(hh)) {
            try { const r = await this.api.getHourIndex([...this.dayParts, hh]); this.hourCache.set(hh, (r && r.gops) || []); }
            catch { return []; }
        }
        return this.hourCache.get(hh) || [];
    }

    private async gopAt(wall: number): Promise<{ hh: string; g: GopEntry } | undefined> {
        const base = this.hourNumOf(wall);
        for (let hn = base; hn >= Math.max(0, base - 3); hn--) {
            const gops = await this.ensureHour(hn);
            let found: GopEntry | undefined;
            for (const g of gops) { if (g.t <= wall) found = g; else break; }
            if (found) return { hh: pad2(hn), g: found };
        }
        for (let hn = base; hn <= Math.min(23, base + 3); hn++) {
            const gops = await this.ensureHour(hn);
            if (gops.length) return { hh: pad2(hn), g: gops[0] };
        }
        return undefined;
    }

    private async fetchNals(_hh: string, g: GopEntry): Promise<Buffer[]> {
        // The data file (g.f = "<HH>.<session>.data") lives in the day directory.
        const data = await this.api.getGopData(this.dayParts, g.f, g.o, g.l);
        return splitFramedNals(Buffer.from(data));
    }

    private async appendGop(hh: string, g: GopEntry, nals?: Buffer[]): Promise<void> {
        if (this.appended.has(g.t)) return;
        this.appended.add(g.t);
        try {
            const ns = nals || await this.fetchNals(hh, g);
            const mp4 = await H264toMP4({ buffer: ns, frameDurationInSeconds: 1 / FPS, mediaStartTimeSeconds: this.internalSec(g.t) });
            await this.enqueue(Buffer.from(mp4.buffer));
        } catch (e) { this.appended.delete(g.t); throw e; }
    }

    private enqueue(buf: Buffer): Promise<void> {
        return new Promise(res => { this.queue.push({ buf, resolve: res }); this.flush(); });
    }
    private flush(): void {
        if (this.flushing || !this.sb || this.sb.updating || !this.queue.length) return;
        this.flushing = true;
        const item = this.queue.shift()!;
        const done = () => { this.sb!.removeEventListener("updateend", done); this.flushing = false; item.resolve(); this.flush(); };
        this.sb.addEventListener("updateend", done);
        try { this.sb.appendBuffer(item.buf as any); } catch { this.flushing = false; item.resolve(); }
    }

    async loadRange(startWall: number, endWall: number): Promise<void> {
        for (let hn = this.hourNumOf(startWall); hn <= 23 && (this.dayStartMs + hn * 3600_000) <= endWall; hn++) {
            const hh = pad2(hn);
            for (const g of await this.ensureHour(hn)) {
                if (g.t + this.gopDurMs(g) < startWall) continue;
                if (g.t > endWall) return;
                if (!this.appended.has(g.t)) { try { await this.appendGop(hh, g); } catch { return; } }
            }
        }
    }

    private evictBefore(sec: number): void {
        if (!this.sb || this.sb.updating || this.queue.length || sec <= 0) return;
        try { if (this.sb.buffered.length && this.sb.buffered.start(0) < sec - 5) this.sb.remove(0, sec); } catch { /* */ }
    }

    teardown(): void {
        this.video.removeEventListener("timeupdate", this.onTimeUpdate);
        for (const ev of ["playing", "waiting", "pause", "seeked", "ended", "stalled", "canplay"]) {
            this.video.removeEventListener(ev, this.refreshStatus);
        }
        try { this.video.pause(); this.video.removeAttribute("src"); this.video.load(); } catch { /* */ }
        this.ms = undefined; this.sb = undefined;
        this.appended.clear(); this.queue = []; this.flushing = false; this.hourCache.clear();
    }
}
