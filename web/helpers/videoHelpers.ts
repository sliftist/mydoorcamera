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
import { splitFramedNals } from "../../src/annexb";
import { H264toMP4 } from "mp4-typescript";
import { FPS } from "../../src/config";

export type PlayStatus = "playing" | "paused" | "waiting" | "unavailable";

function codecFromSps(nals: Buffer[]): string {
    const sps = nals.find(n => (n[0] & 0x1f) === 7);
    if (!sps || sps.length < 4) return "avc1.4D0028";
    const hex = (b: number) => b.toString(16).padStart(2, "0");
    return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}
function pad2(n: number): string { return String(n).padStart(2, "0"); }
const DAY_MS = 24 * 3600 * 1000;
// Background buffering targets (scaled up by playback speed): keep this many GOPs
// buffered into the future, fetching this many concurrently at a time.
const BUFFER_TARGET_GOPS = 10;
const BUFFER_BATCH_GOPS = 4;
const PREBUFFER_DELAY_MS = 200; // after a paused seek settles, wait this long, then buffer ahead

export class DayPlayer {
    private ms: MediaSource | undefined;
    private sb: SourceBuffer | undefined;
    private appended = new Set<number>();
    private queue: { buf: Buffer; resolve: () => void }[] = [];
    private flushing = false;
    private hourCache = new Map<string, GopEntry[]>();
    // Thinned-level playback (level>0): all the day's thinned GOPs are tiny, so we
    // load them once. `comp` (= 30^level) compresses real time into MSE time, so a
    // GOP at real time g.t plays at (g.t - dayStart)/1000/comp seconds.
    private comp = 1;
    private levelGops: GopEntry[] = [];
    private levelReady: Promise<void> | undefined;

    private intent: "play" | "pause" = "pause";
    private targetWall: number;
    private shownWall = -1;
    private pumping = false;
    private pumpGen = 0;                // bumped to supersede an in-flight seek pump (e.g. when live starts/stops)
    private prebufferTimer: ReturnType<typeof setTimeout> | undefined; // deferred trailing-GOP prebuffer (paused seeks)
    private status: PlayStatus = "paused";
    private speed = 1;                  // playback speed for non-live review (1/16 .. 16)
    private live = false;
    private firstLive = true;
    private lastReceivedEnd = 0; // max end-time of any GOP received from the live stream (real wall ms)
    private minBuffer = Infinity;      // buffer trough since the last rate tick
    private rateTimer: ReturnType<typeof setInterval> | undefined;
    // Live timeline: GOPs are appended CONTIGUOUSLY on a synthetic MSE timeline
    // (real-clock jitter would otherwise leave sub-frame gaps between GOPs that MSE
    // stalls on). You can't seek during live, so exact timestamps don't matter.
    private liveCursorSec = 0;          // MSE seconds where the next live GOP is appended
    private liveFramesTotal = 0;        // frames appended into the live timeline
    private liveCheckpoints: { mse: number; frames: number }[] = []; // (mseEnd, cumFrames) per GOP -> map currentTime to played frames
    private liveBase = { mse: 0, frames: 0 };  // origin for the checkpoint map (advances as old checkpoints are pruned)
    private liveStartWall = 0;          // real wall ms of the first live frame (playhead display only)
    private liveFactor = 1;             // catch-up factor (>1 = catching up), applied via playbackRate or frame-compression
    private liveChain: Promise<void> = Promise.resolve(); // serializes live appends so the contiguous cursor never races
    private catchupMode: "rate" | "compress" = "rate"; // how to catch up: speed up the player, or mux frames shorter
    private wdLastTime = -1;           // stall watchdog
    private wdStall = 0;
    private watchdogTimer: ReturnType<typeof setInterval> | undefined;

    private spanEndMs = 0;              // end of the navigable period (day/month/year)
    private destroyed = false;

    private seekingState = false;

    onStatus: ((s: PlayStatus) => void) | undefined;
    onTime: ((wallMs: number) => void) | undefined;
    onRate: ((rate: number) => void) | undefined;
    onBuffer: ((sec: number) => void) | undefined;
    onSeeking: ((seeking: boolean) => void) | undefined; // true while chasing a seek target we haven't shown yet

    private setSeeking(s: boolean): void { if (s !== this.seekingState) { this.seekingState = s; this.onSeeking?.(s); } }

    constructor(
        public video: HTMLVideoElement,
        public api: CameraApi,
        public dayParts: string[],
        public dayStartMs: number,
        public ranges: { start: number; end: number }[],
        public level = 0,
        periodEndMs = 0,
    ) {
        this.comp = Math.pow(30, level);
        this.spanEndMs = periodEndMs || dayStartMs + DAY_MS;
        this.targetWall = dayStartMs;
        this.video.addEventListener("timeupdate", this.onTimeUpdate);
        for (const ev of ["playing", "waiting", "pause", "seeked", "ended", "stalled", "canplay"]) {
            this.video.addEventListener(ev, this.refreshStatus);
        }
        this.watchdogTimer = setInterval(() => this.watchdog(), 500);
        this.scheduleFrameCb(); // per-frame playhead updates (the video tells us when it shows a frame)
    }

    // Drive onTime off actual presented frames (requestVideoFrameCallback) so the
    // playhead tracks real playback, not just the ~4Hz timeupdate event.
    private scheduleFrameCb(): void {
        const v: any = this.video;
        if (typeof v.requestVideoFrameCallback !== "function") return;
        const cb = () => {
            if (this.destroyed) return;
            this.onTime?.(this.currentWall());
            v.requestVideoFrameCallback(cb);
        };
        v.requestVideoFrameCallback(cb);
    }

    // Buffered MSE ranges mapped back to wall-clock time (what's actually loaded
    // into the player) — drives the solid-green "loaded" band on the trackbar.
    bufferedWallRanges(): { start: number; end: number }[] {
        const b = this.sb?.buffered;
        if (!b) return [];
        const out: { start: number; end: number }[] = [];
        for (let i = 0; i < b.length; i++) out.push({ start: this.dayStartMs + b.start(i) * 1000 * this.comp, end: this.dayStartMs + b.end(i) * 1000 * this.comp });
        return out;
    }

    // ---- helpers ----
    internalSec(wall: number): number { return (wall - this.dayStartMs) / 1000 / this.comp; }
    currentWall(): number {
        // Live runs on a synthetic contiguous timeline; map the playhead back to real
        // wall time via the played-frame count so the displayed clock stays correct.
        if (this.live) return this.liveStartWall + (this.liveFramesAt(this.video.currentTime) / FPS) * 1000;
        return this.dayStartMs + this.video.currentTime * 1000 * this.comp;
    }
    // Interpolate how many live frames have been played by MSE time `mse`.
    private liveFramesAt(mse: number): number {
        let prevMse = this.liveBase.mse, prevFrames = this.liveBase.frames;
        for (const cp of this.liveCheckpoints) {
            if (mse <= cp.mse) {
                const span = cp.mse - prevMse;
                return prevFrames + (span > 0 ? (mse - prevMse) / span : 1) * (cp.frames - prevFrames);
            }
            prevMse = cp.mse; prevFrames = cp.frames;
        }
        return prevFrames;
    }
    private hourNumOf(wall: number): number { return Math.floor((wall - this.dayStartMs) / 3600_000); }
    private gopDurMs(g: GopEntry): number { return this.level > 0 ? Math.max(1, g.e - g.t) : Math.round((g.n / FPS) * 1000); }

    // Load all of the day's thinned GOPs once (level>0). Levels are small.
    private ensureLevelLoaded(): Promise<void> {
        if (!this.levelReady) this.levelReady = (async () => {
            try { const r = await this.api.getLevelIndex(this.level, this.dayStartMs, this.spanEndMs); this.levelGops = ((r && r.gops) || []).slice().sort((a, b) => a.t - b.t); }
            catch { this.levelGops = []; }
        })();
        return this.levelReady;
    }
    private coveredAt(wall: number): boolean { return this.ranges.some(r => wall >= r.start && wall <= r.end + 500); }

    // Drop the cached index so the next lookup re-fetches it — called when new
    // footage appears (live-grow), since our index cache would otherwise miss it.
    invalidateIndex(): void { this.hourCache.clear(); this.levelReady = undefined; }

    get playStatus(): PlayStatus { return this.status; }
    get wantsPlay(): boolean { return this.intent === "play"; }
    // Real seconds per playback second at this level (30^level) — used to scale the
    // arrow-key seek step so it moves a sensible amount at every thinning level.
    get compression(): number { return this.comp; }

    // ---- intent ----
    togglePlay(): void { if (this.intent === "play") this.pause(); else this.play(); }
    play(): void {
        this.intent = "play";
        this.refreshStatus();
        // If a seek is still in flight, don't start playback from the video's current
        // (not-yet-updated) frame — let runSeekPump start playback from the seek target
        // once it settles. Otherwise play from the intended position (seek target / last
        // playhead), NOT the video element's current time.
        if (this.pumping) return;
        void this.startPlaybackFrom(this.targetWall);
    }
    pause(): void { this.intent = "pause"; try { this.video.pause(); } catch { /* */ } this.refreshStatus(); }

    // Playback speed for review. Higher speed -> buffer proportionally more ahead.
    setSpeed(s: number): void {
        this.speed = s;
        if (!this.live) { try { this.video.playbackRate = s; } catch { /* */ } }
    }
    // How to catch up during live: "rate" speeds up the player (default); "compress"
    // muxes incoming frames with a shorter duration so the player burns through them
    // faster at 1×. Takes effect on the next live GOP.
    setCatchupMode(m: "rate" | "compress"): void {
        this.catchupMode = m;
        if (this.live && m === "rate") { try { this.video.playbackRate = this.liveFactor; } catch { /* */ } }
        if (this.live && m === "compress") { try { this.video.playbackRate = 1; } catch { /* */ } }
    }
    get catchup(): "rate" | "compress" { return this.catchupMode; }

    // ---- seeking (click / drag / arrows) ----
    seekTo(wall: number): void {
        if (this.live) return; // live owns the playhead; ignore review seeks until we exit live
        if (this.prebufferTimer) { clearTimeout(this.prebufferTimer); this.prebufferTimer = undefined; } // a new seek cancels pending prebuffer
        this.targetWall = Math.max(this.dayStartMs, Math.min(this.spanEndMs - 1, wall));
        try { this.video.pause(); } catch { /* */ }   // static frames while seeking
        this.refreshStatus();
        void this.runSeekPump();
    }
    nudge(deltaMs: number): void { this.seekTo((this.targetWall >= 0 ? this.targetWall : this.currentWall()) + deltaMs); }
    seekTarget(): number { return this.targetWall; }

    // Abort any in-flight seek pump (newest generation wins). Called when live
    // mode takes over the playhead, or on teardown.
    private cancelPump(): void {
        this.pumpGen++;
        this.pumping = false;
        if (this.prebufferTimer) { clearTimeout(this.prebufferTimer); this.prebufferTimer = undefined; }
        this.setSeeking(false);
    }

    private async runSeekPump(): Promise<void> {
        const gen = ++this.pumpGen;   // newest target wins; a live transition bumps pumpGen to abort us
        if (this.pumping) return;     // an active loop will pick up the new targetWall
        this.pumping = true;
        this.setSeeking(true); // haven't shown the target frame yet
        try {
            while (gen === this.pumpGen && !this.live && this.shownWall !== this.targetWall) {
                const t = this.targetWall;        // always chase the latest
                await this.showFrameAt(t);
                this.shownWall = t;
            }
        } finally {
            this.pumping = false;
        }
        if (gen !== this.pumpGen || this.live) return; // superseded (e.g. live started) — don't start playback/prebuffer
        this.setSeeking(false); // target frame is now shown
        // Settled on a target. If playing, kick off normal windowed buffering +
        // playback; if paused, still prebuffer a few seconds so hitting play (or a
        // resume) starts immediately.
        if (this.intent === "play") { void this.startPlaybackFrom(this.targetWall); return; }
        // Paused: the target frame is already rendered. DEFER the trailing prebuffer
        // so a drag (which re-seeks) cancels it — we never download GOPs we're leaving.
        if (this.prebufferTimer) clearTimeout(this.prebufferTimer);
        const w = this.targetWall;
        this.prebufferTimer = setTimeout(() => { void this.bufferAhead(w); }, PREBUFFER_DELAY_MS);
    }

    private async showFrameAt(wall: number): Promise<void> {
        if (this.live) return; // live owns the timeline — don't rebuild the MSE underneath it
        if (!this.coveredAt(wall)) { this.setStatus("unavailable"); return; }
        let target = await this.gopAt(wall);
        // Coverage says there's footage here but our cached index ends well before
        // it — the cache is stale (live edge). Re-fetch once and retry.
        if (target && wall - target.g.e > Math.max(2000, this.gopDurMs(target.g))) {
            this.invalidateIndex();
            target = await this.gopAt(wall);
        }
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
        if (this.intent !== "play" || this.live) return;
        if (!this.coveredAt(wall)) { this.setStatus("unavailable"); return; }
        const target = await this.gopAt(wall);
        if (!target) { this.setStatus("unavailable"); return; }
        // Append only the GOP at the play point, then start immediately — don't
        // wait for the whole buffer window. The rest streams in the background
        // (onTimeUpdate keeps buffering ahead), so seeks/play feel instant.
        await this.ensureSourceBuffer(target);
        await this.appendGop(target.hh, target.g);
        if (this.intent !== "play") return;
        if (Math.abs(this.currentWall() - wall) > 1500) { try { this.video.currentTime = this.internalSec(wall); } catch { /* */ } }
        try { this.video.playbackRate = this.speed; } catch { /* */ }
        try { await this.video.play(); } catch { /* gesture needed */ }
        this.refreshStatus();
        void this.bufferAhead(wall); // buffer multiple GOPs ahead, concurrently, in the background
    }

    private onTimeUpdate = (): void => {
        if (this.live) {
            const buf = this.bufferedSec();
            this.minBuffer = Math.min(this.minBuffer, buf); // track the trough for the rate decision
            this.onBuffer?.(buf);
            this.onTime?.(this.currentWall());
            return;
        }
        const wall = this.currentWall();
        this.onTime?.(wall);
        if (this.intent === "play" && !this.video.paused && !this.pumping) {
            this.targetWall = wall; // keep the intended position synced so pause→play resumes where it stopped
            void this.bufferAhead(wall);
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

    // Wait for a freshly-created MediaSource to open, but never hang: if it's torn
    // down (replaced) before opening, 'sourceopen' never fires, so bail after 3s.
    private waitSourceOpen(ms: MediaSource): Promise<void> {
        return new Promise<void>((res, rej) => {
            const ok = () => { clearTimeout(t); res(); };
            const t = setTimeout(() => { ms.removeEventListener("sourceopen", ok); rej(new Error("sourceopen timeout")); }, 3000);
            ms.addEventListener("sourceopen", ok, { once: true });
        });
    }

    // ---- buffering primitives ----
    private async ensureSourceBuffer(target: { hh: string; g: GopEntry }): Promise<void> {
        if (this.sb) return;
        const nals = await this.fetchNals(target.hh, target.g);
        this.ms = new MediaSource();
        this.video.src = URL.createObjectURL(this.ms);
        await this.waitSourceOpen(this.ms);
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
        if (this.level > 0) {
            await this.ensureLevelLoaded();
            let found: GopEntry | undefined;
            for (const g of this.levelGops) { if (g.t <= wall) found = g; else break; }
            if (!found && this.levelGops.length) found = this.levelGops[0];
            return found ? { hh: "", g: found } : undefined;
        }
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
        // L0: data file lives in the day directory. Thinned levels: fetch by level + t.
        const data = this.level > 0
            ? await this.api.getLevelGopData(this.level, g.t, g.f, g.o, g.l)
            : await this.api.getGopData(this.dayParts, g.f, g.o, g.l);
        return splitFramedNals(Buffer.from(data));
    }

    // True if the MSE timeline second `sec` currently holds data.
    private isBuffered(sec: number): boolean {
        const b = this.sb?.buffered;
        if (!b) return false;
        for (let i = 0; i < b.length; i++) if (sec >= b.start(i) - 0.05 && sec < b.end(i) + 0.1) return true;
        return false;
    }

    // Wall time of the GOP immediately following `g` (the next keyframe), if known.
    // Used to make muxed GOPs contiguous: stretch the last frame up to the next
    // keyframe so playback doesn't stall on the few-ms capture jitter at each seam.
    private async nextStartWall(g: GopEntry): Promise<number | undefined> {
        if (this.level > 0) {
            await this.ensureLevelLoaded();
            for (const x of this.levelGops) if (x.t > g.t) return x.t; // sorted ascending
            return undefined;
        }
        for (let hn = this.hourNumOf(g.t); hn <= 23; hn++) {
            for (const x of await this.ensureHour(hn)) if (x.t > g.t) return x.t;
        }
        return undefined;
    }

    // Per-GOP playback frame duration. Normally 1/FPS, but if the next keyframe is
    // near where this GOP nominally ends, fill exactly up to it (eliminates the seam
    // gap). A far-away next keyframe means genuinely missing footage — leave the gap.
    private async muxFrameDur(g: GopEntry): Promise<number> {
        const nominalSec = g.n / FPS;
        const next = await this.nextStartWall(g);
        if (next == null) return 1 / FPS;
        const spanSec = (next - g.t) / 1000 / this.comp; // playback seconds between this GOP and the next
        return spanSec > 0 && spanSec <= nominalSec * 2 ? spanSec / g.n : 1 / FPS; // bridge jitter; leave real (missing-footage) gaps
    }

    private async appendGop(hh: string, g: GopEntry, nals?: Buffer[]): Promise<void> {
        // Re-append if we marked it appended but it was since evicted from the
        // SourceBuffer — otherwise a seek back to it freezes (no data, no re-fetch).
        if (this.appended.has(g.t) && this.isBuffered(this.internalSec(g.t))) return;
        this.appended.add(g.t);
        try {
            const buf = nals || await this.fetchNals(hh, g);
            const frameDur = await this.muxFrameDur(g);
            const mp4 = await H264toMP4({ buffer: buf, frameDurationInSeconds: frameDur, mediaStartTimeSeconds: this.internalSec(g.t) });
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

    // The next `count` GOPs at/after `fromWall` (the GOP containing it and the ones
    // following), across hours (L0) or the level index (thinned).
    private async gopsAhead(fromWall: number, count: number): Promise<{ hh: string; g: GopEntry }[]> {
        const out: { hh: string; g: GopEntry }[] = [];
        if (this.level > 0) {
            await this.ensureLevelLoaded();
            for (const g of this.levelGops) {
                if (g.t + this.gopDurMs(g) < fromWall) continue;
                out.push({ hh: "", g });
                if (out.length >= count) break;
            }
            return out;
        }
        for (let hn = this.hourNumOf(fromWall); hn <= 23 && out.length < count; hn++) {
            const hh = pad2(hn);
            for (const g of await this.ensureHour(hn)) {
                if (g.t + this.gopDurMs(g) < fromWall) continue;
                out.push({ hh, g });
                if (out.length >= count) break;
            }
        }
        return out;
    }

    // Run `fn` over items with at most `limit` running concurrently.
    private async runBounded<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
        let i = 0;
        const worker = async () => { while (i < items.length) await fn(items[i++]); };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    }

    // Prefetch GOPs ahead of `fromWall` so playback keeps up. Unlike a single seek
    // fetch, this requests several GOPs concurrently and aims to keep a number of
    // them buffered into the future — both scaled by the playback speed (faster
    // playback consumes GOPs faster, so fetch more at once and keep more ahead).
    private bufferingAhead = false;
    private async bufferAhead(fromWall: number): Promise<void> {
        if (this.bufferingAhead || this.live) return;
        this.bufferingAhead = true;
        try {
            const rate = Math.max(1, this.speed);
            const target = Math.min(200, Math.round(BUFFER_TARGET_GOPS * rate)); // GOPs to keep ahead
            const batch = Math.min(16, Math.round(BUFFER_BATCH_GOPS * rate));    // concurrent fetches
            const list = await this.gopsAhead(fromWall, target);
            // appendGop is a cheap no-op for GOPs already buffered, so only the
            // not-yet-fetched frontier actually hits the network.
            await this.runBounded(list, batch, x => this.appendGop(x.hh, x.g).catch(() => { /* */ }));
        } finally { this.bufferingAhead = false; }
    }

    private evictBefore(sec: number): void {
        if (!this.sb || this.sb.updating || this.queue.length || sec <= 0) return;
        try { if (this.sb.buffered.length && this.sb.buffered.start(0) < sec - 5) this.sb.remove(0, sec); } catch { /* */ }
    }

    // ---- live streaming ----
    get isLive(): boolean { return this.live; }

    async startLive(): Promise<void> {
        this.cancelPump();  // a review seek pump must not rebuild the MSE / move the playhead under live
        this.live = true; this.intent = "play"; this.firstLive = true;
        this.lastReceivedEnd = 0; this.liveFactor = 1; this.minBuffer = Infinity;
        this.liveCursorSec = 0; this.liveFramesTotal = 0; this.liveCheckpoints = []; this.liveBase = { mse: 0, frames: 0 };
        this.liveStartWall = 0; this.liveChain = Promise.resolve();
        this.teardownMse(); // fresh timeline starting at the live edge
        if (this.rateTimer) clearInterval(this.rateTimer);
        this.rateTimer = setInterval(() => this.tickRate(), 1000);
        try { await this.api.startStream(this.dayParts.join("/"), (meta, bytes) => void this.onLiveData(meta, bytes)); }
        catch (e) { this.live = false; throw e; }
        this.refreshStatus();
    }

    async stopLive(): Promise<void> {
        this.live = false;
        this.cancelPump();           // clear any stale pump state so review seeks work again
        this.shownWall = -1;         // force the next seek to actually render a frame
        if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = undefined; }
        try { this.video.pause(); } catch { /* */ } // stop the live buffer from running on
        try { this.video.playbackRate = this.speed; } catch { /* */ }
        this.liveFactor = 1;
        this.onRate?.(1);
        this.onBuffer?.(0);
        try { await this.api.stopStream(); } catch { /* */ }
        this.intent = "pause"; this.refreshStatus();
    }

    private async ensureSourceBufferWithNals(nals: Buffer[]): Promise<void> {
        if (this.sb) return;
        this.ms = new MediaSource();
        this.video.src = URL.createObjectURL(this.ms);
        await this.waitSourceOpen(this.ms);
        this.sb = this.ms.addSourceBuffer(`video/mp4; codecs="${codecFromSps(nals)}"`);
    }

    // Live backlog (real seconds): frames received but not yet played, / FPS.
    private bufferedSec(): number {
        if (!this.live) return Math.max(0, (this.lastReceivedEnd - this.currentWall()) / 1000);
        return Math.max(0, (this.liveFramesTotal - this.liveFramesAt(this.video.currentTime)) / FPS);
    }

    private onLiveData(meta: { t: number; e: number; n: number }, bytes: Uint8Array): void {
        if (!this.live) return;
        this.lastReceivedEnd = Math.max(this.lastReceivedEnd, meta.e);
        const nals = splitFramedNals(Buffer.from(bytes));
        // Serialize appends so the contiguous cursor / frame counters never race.
        this.liveChain = this.liveChain.then(() => this.appendLive(meta, nals)).catch(() => { /* */ });
    }

    private async appendLive(meta: { t: number; e: number; n: number }, nals: Buffer[]): Promise<void> {
        if (!this.live) return;
        await this.ensureSourceBufferWithNals(nals);
        if (!this.live || this.appended.has(meta.t)) return;
        this.appended.add(meta.t);
        // Append back-to-back on the synthetic timeline (no real-time gaps to stall on).
        // "compress" catch-up shortens each frame so the player runs ahead at 1×; "rate"
        // keeps real duration and speeds up the player instead.
        const frameDur = this.catchupMode === "compress" ? 1 / (FPS * this.liveFactor) : 1 / FPS;
        const startSec = this.liveCursorSec;
        try {
            const mp4 = await H264toMP4({ buffer: nals, frameDurationInSeconds: frameDur, mediaStartTimeSeconds: startSec });
            await this.enqueue(Buffer.from(mp4.buffer));
        } catch { this.appended.delete(meta.t); return; }
        this.liveCursorSec = startSec + meta.n * frameDur;
        this.liveFramesTotal += meta.n;
        this.liveCheckpoints.push({ mse: this.liveCursorSec, frames: this.liveFramesTotal });
        if (this.liveCheckpoints.length > 4000) this.liveBase = this.liveCheckpoints.shift()!; // bound the map
        if (!this.liveStartWall) this.liveStartWall = meta.t;
        this.onBuffer?.(this.bufferedSec());
        if (this.firstLive) {
            this.firstLive = false;
            try { this.video.currentTime = startSec; } catch { /* */ }
            try { this.video.playbackRate = this.catchupMode === "rate" ? this.liveFactor : 1; } catch { /* */ }
            this.video.play().catch(() => { /* */ });
        }
    }

    // Rate control, once per second, measured at the buffer trough. Target a 1-2s
    // backlog: above it, ramp the catch-up factor up; below 1s ease back to real-time.
    private tickRate(): void {
        if (!this.live) return;
        const buf = isFinite(this.minBuffer) ? this.minBuffer : this.bufferedSec();
        this.minBuffer = Infinity;
        const reduceStep = () => Math.max(0.02, 0.25 * Math.max(0, this.liveFactor - 1)); // unwind a big catch-up quickly
        if (buf > 2) this.liveFactor = Math.min(4, this.liveFactor + 0.1);                // catch up faster than before (was 1.5× cap)
        else if (buf < 1) this.liveFactor = Math.max(0.5, this.liveFactor - reduceStep());
        else if (this.liveFactor > 1.0001) this.liveFactor = Math.max(1, this.liveFactor - reduceStep());
        else if (this.liveFactor < 0.9999) this.liveFactor = Math.min(1, this.liveFactor + 0.02);
        // "rate" mode applies the factor to the player; "compress" mode applies it to
        // the duration of newly-muxed frames (so the player stays at 1×).
        if (this.catchupMode === "rate") { try { this.video.playbackRate = this.liveFactor; } catch { /* */ } }
        else { try { this.video.playbackRate = 1; } catch { /* */ } }
        this.onRate?.(this.liveFactor);
        this.evictBefore(this.video.currentTime - 15);
    }

    // Stall watchdog: if we want to play but currentTime isn't advancing while
    // there's buffered data ahead (an MSE gap the browser won't cross), jump
    // past it to the next buffered range.
    private watchdog(): void {
        if (this.intent !== "play" || this.video.paused) { this.wdLastTime = this.video.currentTime; this.wdStall = 0; return; }
        const ct = this.video.currentTime;
        if (Math.abs(ct - this.wdLastTime) < 0.02) {
            if (++this.wdStall >= 2) { this.jumpOverGap(); this.wdStall = 0; }
        } else { this.wdStall = 0; }
        this.wdLastTime = ct;
    }
    private jumpOverGap(): void {
        if (!this.sb || !this.sb.buffered.length) return;
        const ct = this.video.currentTime, b = this.sb.buffered;
        let target = -1;
        for (let i = 0; i < b.length; i++) {
            if (b.start(i) > ct + 0.02) { target = b.start(i); break; }                       // a later range starts after a gap
            if (ct <= b.end(i) + 0.02 && i + 1 < b.length) { target = b.start(i + 1); break; } // sitting at this range's end
        }
        if (target >= 0) {
            // Log when the stall watchdog has to skip a gap — during live this means
            // the timeline wasn't contiguous and we're losing ground here.
            console.warn(`[player] stall watchdog jumped a buffer gap: ${ct.toFixed(2)}s -> ${(target + 0.05).toFixed(2)}s${this.live ? " (LIVE — falling behind)" : ""}`);
            try { this.video.currentTime = target + 0.05; void this.video.play(); } catch { /* */ } // jump a touch past the next frame
        }
    }

    // Resolve every pending append promise before discarding the queue, so awaiters
    // (the seek pump) never hang when the SourceBuffer is torn down out from under them.
    private drainQueue(): void {
        for (const item of this.queue) item.resolve();
        this.queue = []; this.flushing = false;
    }

    private teardownMse(): void {
        try { this.video.pause(); this.video.removeAttribute("src"); this.video.load(); } catch { /* */ }
        this.ms = undefined; this.sb = undefined;
        this.appended.clear(); this.drainQueue();
    }

    teardown(): void {
        this.destroyed = true; // stop the per-frame callback loop
        this.cancelPump();
        if (this.prebufferTimer) clearTimeout(this.prebufferTimer);
        if (this.live) { this.live = false; try { void this.api.stopStream(); } catch { /* */ } }
        if (this.rateTimer) clearInterval(this.rateTimer);
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);
        this.video.removeEventListener("timeupdate", this.onTimeUpdate);
        for (const ev of ["playing", "waiting", "pause", "seeked", "ended", "stalled", "canplay"]) {
            this.video.removeEventListener(ev, this.refreshStatus);
        }
        try { this.video.pause(); this.video.removeAttribute("src"); this.video.load(); } catch { /* */ }
        this.ms = undefined; this.sb = undefined;
        this.appended.clear(); this.drainQueue(); this.hourCache.clear();
    }
}
