// CLOCK / SCHEDULER + facade. Owns play state and the requestAnimationFrame loop, runs
// the SMOOTH/SKIP state machine, and wires the parts together: GopSource (downloader),
// FrameCache (generative decode cache), Prebuffer (best-effort look-ahead), Renderer (draw).
//
// Each tick it resolves which GOP+frame the playhead wants, asks the cache for it (the
// cache decodes on a miss), and draws it. Frame ready in time -> show it; not ready -> in
// SMOOTH hold (playback slows), and after 2 holds in a row switch to SKIP (advance at real
// time, drop frames, red border) until 10 on-time frames recover SMOOTH.

import { CameraApi } from "../api";
import { FPS } from "../../../src/config";
import { PlayStatus, GapMode, GopEntry } from "./types";
import { GopSource } from "./gopSource";
import { FrameCache, decodeGop } from "./frameCache";
import { Prebuffer } from "./prebuffer";
import { Renderer } from "./renderer";
import { pushFsmEntry } from "../playerLog";

const MAX_WAIT_MS = 5000;        // hold this long for a frame before showing the "missing" card
const SKIP_AFTER_MISSES = 2;     // consecutive holds before switching to SKIP
const SMOOTH_AFTER_HITS = 10;    // consecutive on-time frames before leaving SKIP
const MAX_CACHED_GOPS = 5;       // decoded GOPs kept (whole-GOP -> memory-bounded)
const WINDOW_GOPS = 32;          // GOP look-up window kept around the playhead
const LIVE_KEEP_FRAMES = 3;      // live: keep only the newest few decoded frames

export class DayPlayer {
    private source: GopSource;
    private cache: FrameCache;
    private prebuffer: Prebuffer;
    private renderer: Renderer;

    private playing = false;
    private live = false;
    private gapModeVal: GapMode = "blank";
    private speed = 1;
    private loopVal: { start: number; end: number } | null = null;
    private destroyed = false;
    private playWall: number;
    private shownWall: number;

    private mode: "smooth" | "skip" = "smooth";
    private consecMiss = 0;
    private consecHit = 0;
    private heldTarget: number | null = null;
    private heldSince = 0;
    private seekPending = false;

    private window: GopEntry[] = []; // GOPs around the playhead (sync lookup); refreshed async
    private windowBusy = false;
    private lastFrame: VideoFrame | undefined; // last frame drawn (for skip-mode "nearest")
    private liveFrames: VideoFrame[] = [];

    private rafId: number | undefined;
    private lastTs = 0;
    private lastEmittedWall = -1;
    private lastStatus: PlayStatus = "paused";
    private lastSeeking = false;
    private lastDropping = false;
    private liveOp: Promise<void> = Promise.resolve();

    onTime: ((wallMs: number) => void) | undefined;
    onStatus: ((s: PlayStatus) => void) | undefined;
    onSeeking: ((seeking: boolean) => void) | undefined;
    onDropping: ((dropping: boolean) => void) | undefined;
    onPending: (() => void) | undefined;

    constructor(
        public canvas: HTMLCanvasElement,
        public api: CameraApi,
        public dayParts: string[],
        public dayStartMs: number,
        ranges: { start: number; end: number }[],
        public level = 0,
        periodEndMs = 0,
    ) {
        const spanEnd = periodEndMs || dayStartMs + 24 * 3600 * 1000;
        this.source = new GopSource(api, dayParts, dayStartMs, ranges, level, spanEnd);
        this.source.onPending = () => this.onPending?.();
        this.cache = new FrameCache(this.source, MAX_CACHED_GOPS);
        this.prebuffer = new Prebuffer(this.source, this.cache);
        this.renderer = new Renderer(canvas);
        this.playWall = dayStartMs;
        this.shownWall = dayStartMs - this.frameStep;
        if (typeof requestAnimationFrame !== "undefined") this.rafId = requestAnimationFrame(this.tick);
    }

    private get comp(): number { return this.source.comp; }
    private get frameStep(): number { return this.source.frameStep; }

    // ============================ public API ============================
    seekTo(wall: number): void { if (this.live || this.destroyed) return; this.jump(wall); this.log("SEEK", Math.round(this.playWall)); }
    play(): void { if (!this.live && !this.destroyed && !this.playing) { this.playing = true; this.log("PLAY"); } }
    pause(): void { if (!this.live && this.playing) { this.playing = false; this.log("PAUSE"); } }
    togglePlay(): void { if (this.playing) this.pause(); else this.play(); }
    setSpeed(s: number): void { this.speed = s > 0 ? s : 1; }
    setLoop(start: number, end: number): void { this.loopVal = { start, end }; }
    clearLoop(): void { this.loopVal = null; }
    setGapMode(m: GapMode): void { this.gapModeVal = m; }
    invalidateIndex(): void { this.source.clearIndex(); this.window = []; }
    nudge(deltaMs: number): void { this.seekTo(this.playWall + deltaMs); }
    seekTarget(): number { return this.playWall; }
    currentWall(): number { return this.playWall; }
    teardown(): void { this.doTeardown(); }
    async startLive(): Promise<void> { this.beginLive(); await this.liveOp; }
    async stopLive(): Promise<void> { this.endLive(); await this.liveOp; }

    get playStatus(): PlayStatus { return this.lastStatus; }
    get wantsPlay(): boolean { return this.playing; }
    get compression(): number { return this.comp; }
    get isLive(): boolean { return this.live; }
    get loop(): { start: number; end: number } | null { return this.loopVal; }
    get gapMode(): GapMode { return this.gapModeVal; }
    get pendingGopTimes(): number[] { return this.source.pendingGopTimes; }
    bufferedWallRanges(): { start: number; end: number }[] { return this.source.bufferedWallRanges(); }
    get ranges(): { start: number; end: number }[] { return this.source.ranges; }
    set ranges(r: { start: number; end: number }[]) { this.source.setRanges(r); }

    // ============================ frame lookup ============================
    // The decoded frame for `wall` (resolved via the GOP window + the cache), or undefined
    // while it decodes. Refreshes the window in the background as the playhead moves.
    private frameAt(wall: number): VideoFrame | undefined {
        let gop: GopEntry | undefined, idx = -1;
        for (let i = 0; i < this.window.length; i++) { if (this.window[i].t <= wall) { gop = this.window[i]; idx = i; } else break; }
        if (!gop || idx >= this.window.length - 2) this.kickWindow();
        if (!gop) return undefined;
        const walls = this.source.frameWalls(gop, gop.n);
        let fi = 0;
        for (let i = 0; i < walls.length; i++) { if (walls[i] <= wall) fi = i; else break; }
        return this.cache.get(gop, fi);
    }
    private kickWindow(): void {
        if (this.windowBusy) return;
        this.windowBusy = true;
        this.source.gopsFrom(this.playWall - this.frameStep, WINDOW_GOPS)
            .then(gs => { this.window = gs; }).catch(() => { /* */ })
            .finally(() => { this.windowBusy = false; });
    }
    // Draw the frame for `wall`; returns whether one was available (a hit).
    private show(wall: number): boolean {
        const f = this.frameAt(wall);
        if (f) { this.renderer.drawFrame(f); this.lastFrame = f; return true; }
        return false;
    }

    // ============================ the loop ============================
    private tick = (ts: number): void => {
        if (this.destroyed) return;
        const dt = this.lastTs ? Math.min(250, ts - this.lastTs) : 0;
        this.lastTs = ts;
        try { this.step(dt); } catch (e) { console.error("[player] step error", e); }
        this.rafId = requestAnimationFrame(this.tick);
    };

    private step(dtMs: number): void {
        if (this.live) { this.stepLive(); return; }
        if (this.playing) {
            if (this.loopVal && this.playWall >= this.loopVal.end) this.jump(this.loopVal.start);
            else if (this.mode === "smooth") this.stepSmooth(dtMs);
            else this.stepSkip(dtMs);
        } else {
            this.stepPaused();
        }
        this.prebuffer.pump(this.playWall);
        this.emit();
    }

    private clampWall(w: number): number { return Math.max(this.dayStartMs, Math.min(this.source.spanEndMs - 1, w)); }

    // SMOOTH — advance at real time; if a frame isn't ready, HOLD (freeze on the previous
    // frame) up to MAX_WAIT; two holds in a row -> SKIP. Shows every frame.
    private stepSmooth(dt: number): void {
        if (this.heldTarget != null) {
            if (this.show(this.heldTarget)) this.settleHeld();
            else if (Date.now() - this.heldSince > MAX_WAIT_MS) { this.renderer.drawMissing(this.heldTarget); this.log("MISSING", Math.round(this.heldTarget)); this.settleHeld(); }
            return;
        }
        const target = this.clampWall(this.playWall + dt * this.comp * this.speed);
        if (!this.source.coveredAt(target)) { this.onGap(target); return; }
        if (this.show(target)) {
            this.playWall = target; this.shownWall = target;
            this.consecHit++; this.consecMiss = 0; this.seekPending = false;
        } else if (!this.seekPending && ++this.consecMiss >= SKIP_AFTER_MISSES) {
            this.consecHit = 0; this.enterSkip();
        } else {
            this.consecHit = 0; this.heldTarget = target; this.heldSince = Date.now();
        }
    }
    private settleHeld(): void { const t = this.heldTarget!; this.playWall = t; this.shownWall = t; this.seekPending = false; this.heldTarget = null; }

    // SKIP — keep real time, drop frames to catch up (red border); recover after N hits.
    private stepSkip(dt: number): void {
        this.playWall = this.clampWall(this.playWall + dt * this.comp * this.speed);
        if (!this.source.coveredAt(this.playWall)) { this.onGap(this.playWall); return; }
        if (this.show(this.playWall)) { this.shownWall = this.playWall; if (++this.consecHit >= SMOOTH_AFTER_HITS) this.exitSkip(); }
        else { if (this.lastFrame) this.renderer.drawFrame(this.lastFrame); this.consecHit = 0; }
    }

    private stepPaused(): void {
        if (!this.source.coveredAt(this.playWall) && this.source.ranges.length) { this.renderer.drawMissing(this.playWall); this.seekPending = false; return; }
        if (this.show(this.playWall)) this.seekPending = false;
    }

    // Coverage gap while playing: skip jumps to the next range; blank advances through it.
    private onGap(target: number): void {
        if (this.gapModeVal === "skip") {
            const next = this.source.nextRangeStart(target);
            if (next != null) { this.jump(next); this.log("SKIPGAP", Math.round(next)); }
            else { this.playing = false; this.log("END"); }
            return;
        }
        this.playWall = target; this.shownWall = target;
        this.renderer.drawMissing(target);
        if (this.source.nextRangeStart(target) == null && !this.source.hasFootageAhead(target)) { this.playing = false; this.log("END"); }
    }

    private enterSkip(): void { this.mode = "skip"; this.consecHit = 0; this.heldTarget = null; this.log("SKIP"); }
    private exitSkip(): void { this.mode = "smooth"; this.consecMiss = 0; this.consecHit = 0; this.shownWall = this.playWall; this.log("SMOOTH"); }

    // A seek / loop-wrap / gap-skip: move the playhead and refresh the lookup window. The
    // cache keeps decoded GOPs, so seeking back into recent footage is instant.
    private jump(wall: number): void {
        this.playWall = this.clampWall(wall);
        this.shownWall = this.playWall - this.frameStep;
        this.seekPending = true;
        this.heldTarget = null;
        this.mode = "smooth";
        this.consecMiss = 0; this.consecHit = 0;
        this.window = []; this.kickWindow();
        this.source.cancelInflight();
    }

    // ============================ live ============================
    private beginLive(): void {
        if (this.live || this.destroyed) return;
        this.live = true; this.playing = true; this.seekPending = false; this.mode = "smooth";
        this.log("LIVE_START");
        this.liveOp = this.doStartLive();
    }
    private endLive(): void {
        if (!this.live) { this.liveOp = Promise.resolve(); return; }
        this.live = false; this.playing = false;
        this.log("LIVE_STOP");
        this.liveOp = this.doStopLive();
    }
    private async doStartLive(): Promise<void> {
        this.closeLiveFrames();
        try { await this.api.startStream(this.dayParts.join("/"), this.onLiveGop); }
        catch (e) { this.live = false; this.playing = false; throw e; }
    }
    private async doStopLive(): Promise<void> {
        try { await this.api.stopStream(); } catch { /* */ }
        this.closeLiveFrames();
    }
    private onLiveGop = async (meta: { t: number; e: number; n: number }, bytes: Uint8Array): Promise<void> => {
        if (!this.live) return;
        const span = meta.n > 0 ? (meta.e - meta.t) / meta.n : 1000 / FPS;
        const walls: number[] = [];
        for (let i = 0; i < Math.max(meta.n, 1); i++) walls.push(meta.t + i * (span > 0 ? span : 1000 / FPS));
        let frames: VideoFrame[];
        try { frames = await decodeGop(Buffer.from(bytes), walls); } catch { return; }
        if (!this.live) { for (const f of frames) { try { f.close(); } catch { /* */ } } return; }
        this.liveFrames.push(...frames);
        this.liveFrames.sort((a, b) => a.timestamp - b.timestamp);
        while (this.liveFrames.length > LIVE_KEEP_FRAMES) { const f = this.liveFrames.shift()!; try { f.close(); } catch { /* */ } }
    };
    private stepLive(): void {
        const newest = this.liveFrames[this.liveFrames.length - 1];
        if (newest) { this.playWall = newest.timestamp / 1000; this.renderer.drawFrame(newest); }
        this.emit();
    }
    private closeLiveFrames(): void { for (const f of this.liveFrames) { try { f.close(); } catch { /* */ } } this.liveFrames = []; }

    // ============================ emit ============================
    private statusNow(): PlayStatus {
        if (this.live) return this.liveFrames.length ? "playing" : "waiting";
        if (!this.source.ranges.length) return "unavailable";
        if (this.seekPending) return this.playing ? "waiting" : "paused";
        return this.playing ? "playing" : "paused";
    }
    private emit(): void {
        const w = Math.round(this.playWall);
        if (w !== this.lastEmittedWall) { this.lastEmittedWall = w; this.onTime?.(this.playWall); }
        const s = this.statusNow();
        if (s !== this.lastStatus) { this.lastStatus = s; this.onStatus?.(s); }
        const seeking = this.seekPending && !this.live;
        if (seeking !== this.lastSeeking) { this.lastSeeking = seeking; this.onSeeking?.(seeking); }
        const dropping = this.mode === "skip" && this.playing && !this.live;
        if (dropping !== this.lastDropping) { this.lastDropping = dropping; this.onDropping?.(dropping); }
    }

    // ============================ debug log ============================
    private log(ev: string, arg?: string | number): void {
        try {
            pushFsmEntry({
                ts: Date.now(), ev, arg, from: this.lastStatus, to: this.statusNow(),
                ctx: {
                    playing: this.playing, live: this.live, mode: this.mode, status: this.lastStatus,
                    playWall: Math.round(this.playWall), shownWall: Math.round(this.shownWall),
                    speed: this.speed, level: this.level, comp: this.comp,
                    consecMiss: this.consecMiss, consecHit: this.consecHit, seekPending: this.seekPending,
                    inFlight: this.api.outstandingGops, covered: this.source.coveredAt(this.playWall),
                    loop: this.loopVal ? `${Math.round(this.loopVal.start)}-${Math.round(this.loopVal.end)}` : null,
                },
            });
        } catch { /* */ }
    }

    // ============================ teardown ============================
    private doTeardown(): void {
        this.destroyed = true;
        if (this.rafId != null && typeof cancelAnimationFrame !== "undefined") { try { cancelAnimationFrame(this.rafId); } catch { /* */ } }
        this.rafId = undefined;
        try { void this.api.stopStream(); } catch { /* */ }
        this.cache.clear();
        this.closeLiveFrames();
    }
}
