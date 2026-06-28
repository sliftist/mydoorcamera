// CLOCK / SCHEDULER + facade. Owns the play state and the requestAnimationFrame loop,
// runs the SMOOTH/SKIP state machine, and wires together the downloader (GopSource),
// decoded-frame cache (FrameCache), decoder (GopDecoder), pre-buffer (Prebuffer) and
// renderer (Renderer). Exposes the same public API + callbacks the rest of the app uses.
//
// The contract: the renderer is self-sufficient (reads the cache, decodes on miss), the
// pre-buffer is purely additive, and the clock decides — frame ready in time? show it;
// not ready? in SMOOTH hold (playback slows) and after 2 holds in a row switch to SKIP
// (advance at real time, drop frames, red border) until 10 on-time frames recover SMOOTH.

import { CameraApi } from "../api";
import { FPS } from "../../../src/config";
import { PlayStatus, GapMode } from "./types";
import { GopSource } from "./gopSource";
import { FrameCache } from "./frameCache";
import { GopDecoder } from "./gopDecoder";
import { Prebuffer } from "./prebuffer";
import { Renderer } from "./renderer";
import { pushFsmEntry } from "../playerLog";

const MAX_WAIT_MS = 5000;        // hold this long for a frame's data before showing "missing"
const SKIP_AFTER_MISSES = 2;     // consecutive holds before switching to SKIP mode
const SMOOTH_AFTER_HITS = 10;    // consecutive on-time frames before leaving SKIP mode
const FRAME_CACHE_MAX = 240;     // decoded VideoFrames retained (memory cap)
const LIVE_KEEP_MS = 1500;       // live: keep ~this much footage of decoded frames behind newest
const W: any = typeof window !== "undefined" ? window : {};

export class DayPlayer {
    private source: GopSource;
    private cache: FrameCache;
    private decoder: GopDecoder;
    private prebuffer: Prebuffer;
    private renderer: Renderer;

    // play state
    private playing = false;
    private live = false;
    private gapModeVal: GapMode = "blank";
    private speed = 1;
    private loopVal: { start: number; end: number } | null = null;
    private destroyed = false;
    private playWall: number;
    private shownWall: number;

    // scheduler
    private mode: "smooth" | "skip" = "smooth";
    private consecMiss = 0;
    private consecHit = 0;
    private heldTarget: number | null = null;
    private heldSince = 0;
    private seekPending = false;

    // rAF
    private rafId: number | undefined;
    private lastTs = 0;

    // emit de-dup
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
        this.cache = new FrameCache(FRAME_CACHE_MAX);
        this.decoder = new GopDecoder(this.source, this.cache);
        this.prebuffer = new Prebuffer(this.source, this.decoder, this.cache);
        this.renderer = new Renderer(canvas, this.source, this.cache, this.decoder);
        this.playWall = dayStartMs;
        this.shownWall = dayStartMs - this.source.frameStep;
        this.rafId = W.requestAnimationFrame ? W.requestAnimationFrame(this.tick) : undefined;
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
    invalidateIndex(): void { this.source.clearIndex(); }
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

    // ============================ the loop ============================
    private tick = (ts: number): void => {
        if (this.destroyed) return;
        const dt = this.lastTs ? Math.min(250, ts - this.lastTs) : 0;
        this.lastTs = ts;
        try { this.step(dt); } catch (e) { console.error("[player] step error", e); }
        this.rafId = W.requestAnimationFrame(this.tick);
    };

    private step(dtMs: number): void {
        if (this.live) { this.stepLive(); return; }
        if (this.playing) {
            if (this.loopVal && this.playWall >= this.loopVal.end) { this.jump(this.loopVal.start); }
            else if (this.mode === "smooth") this.stepSmooth(dtMs);
            else this.stepSkip(dtMs);
        } else {
            this.stepPaused();
        }
        this.prebuffer.pump(this.playWall, this.speed);
        this.cache.evictBehind(this.playWall - this.frameStep * 3);
        this.emit();
    }

    private clampWall(w: number): number { return Math.max(this.dayStartMs, Math.min(this.source.spanEndMs - 1, w)); }

    // SMOOTH — advance at real time; if the frame isn't ready, HOLD (freeze, showing the
    // previous frame) up to MAX_WAIT; two holds in a row -> SKIP. Shows every frame.
    private stepSmooth(dt: number): void {
        if (this.heldTarget != null) {
            const r = this.renderer.renderAt(this.heldTarget, true);
            const now = Date.now();
            if (r === "hit") { this.settleHeld(); }
            else if (now - this.heldSince > MAX_WAIT_MS) { this.renderer.drawMissing(this.heldTarget); this.log("MISSING", Math.round(this.heldTarget)); this.settleHeld(); }
            return; // frozen until the held frame resolves
        }
        const target = this.clampWall(this.playWall + dt * this.comp * this.speed);
        if (!this.source.coveredAt(target)) { this.onGap(target); return; }
        const r = this.renderer.renderAt(target, false);
        if (r === "hit") {
            this.playWall = target; this.shownWall = target;
            this.consecHit++; this.consecMiss = 0; this.seekPending = false;
        } else {
            if (!this.seekPending) {
                this.consecMiss++; this.consecHit = 0;
                if (this.consecMiss >= SKIP_AFTER_MISSES) { this.enterSkip(); return; }
            }
            this.heldTarget = target; this.heldSince = Date.now();
        }
    }
    private settleHeld(): void {
        const t = this.heldTarget!;
        this.playWall = t; this.shownWall = t; this.seekPending = false; this.heldTarget = null;
    }

    // SKIP — keep real time, drop frames to catch up (red border); recover after N on-time hits.
    private stepSkip(dt: number): void {
        this.playWall = this.clampWall(this.playWall + dt * this.comp * this.speed);
        if (!this.source.coveredAt(this.playWall)) { this.onGap(this.playWall); return; }
        const r = this.renderer.renderAt(this.playWall, false);
        if (r === "hit") { this.shownWall = this.playWall; this.consecHit++; if (this.consecHit >= SMOOTH_AFTER_HITS) this.exitSkip(); }
        else { this.renderer.drawNearest(this.playWall); this.consecHit = 0; }
    }

    private stepPaused(): void {
        if (!this.source.coveredAt(this.playWall) && this.source.ranges.length) {
            this.renderer.drawMissing(this.playWall); this.seekPending = false; return; // paused over a gap
        }
        if (this.renderer.renderAt(this.playWall, true) === "hit") this.seekPending = false;
        // miss: keep the previous frame; seekPending (yellow) stays until the target paints
    }

    // Coverage gap while playing: skip jumps to the next range; blank advances the clock
    // through it (drawing the missing card). End of footage -> pause.
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

    // A seek / loop-wrap / gap-skip: move the playhead, reset the decode pipeline so the new
    // target decodes immediately, and show the yellow outline until it paints.
    private jump(wall: number): void {
        this.playWall = this.clampWall(wall);
        this.shownWall = this.playWall - this.frameStep;
        this.seekPending = true;
        this.heldTarget = null;
        this.mode = "smooth";
        this.consecMiss = 0; this.consecHit = 0;
        this.decoder.reset();
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
        this.decoder.reset(); this.cache.clear();
        try { await this.api.startStream(this.dayParts.join("/"), (meta, bytes) => this.decoder.feedLive(meta, bytes)); }
        catch (e) { this.live = false; this.playing = false; throw e; }
    }
    private async doStopLive(): Promise<void> {
        try { await this.api.stopStream(); } catch { /* */ }
        this.decoder.reset();
    }
    private stepLive(): void {
        const newest = this.cache.newest();
        if (newest) { this.playWall = newest.wall; this.renderer.drawFrame(newest.frame); this.shownWall = newest.wall; }
        this.cache.evictBehind(this.playWall - LIVE_KEEP_MS);
        this.emit();
    }

    // ============================ emit ============================
    private statusNow(): PlayStatus {
        if (this.live) return this.cache.newest() ? "playing" : "waiting";
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
                    cached: this.cache.size, consecMiss: this.consecMiss, consecHit: this.consecHit,
                    seekPending: this.seekPending, inFlight: this.api.outstandingGops,
                    covered: this.source.coveredAt(this.playWall),
                    loop: this.loopVal ? `${Math.round(this.loopVal.start)}-${Math.round(this.loopVal.end)}` : null,
                },
            });
        } catch { /* */ }
    }

    // ============================ teardown ============================
    private doTeardown(): void {
        this.destroyed = true;
        if (this.rafId != null && W.cancelAnimationFrame) { try { W.cancelAnimationFrame(this.rafId); } catch { /* */ } }
        this.rafId = undefined;
        try { void this.api.stopStream(); } catch { /* */ }
        this.decoder.dispose();
        this.cache.clear();
    }
}
