// CLOCK / SCHEDULER + facade for REVIEW playback (live is a separate LivePlayer). Owns the
// playhead and a requestAnimationFrame loop that:
//   - keeps AT MOST ONE outstanding "render this frame" request (drawFrameAt is async — it
//     resolves the GOP, gets/decodes the frame, and draws). While one is in flight we don't
//     start another; after MAX_WAIT we give up on it and show the "missing" card.
//   - decides when the playback time advances, when to skip frames, and when to jump gaps.
//
// SMOOTH: advance one frame at real-time cadence, showing every frame (playback just slows
// if a render is slow). Two slow renders in a row -> SKIP: advance by real elapsed time
// (dropping frames, red border) until SMOOTH_AFTER_HITS on-time renders recover SMOOTH.

import { CameraApi } from "../api";
import { FPS } from "../../../src/config";
import { PlayStatus, GapMode } from "./types";
import { GopSource } from "./gopSource";
import { Prebuffer } from "./prebuffer";
import { Renderer } from "./renderer";
import { getFrame } from "./frameCache";
import { pushFsmEntry } from "../playerLog";

const MAX_WAIT_MS = 5000;       // give up on a frame's render after this, show "missing"
const SKIP_AFTER_MISSES = 2;    // slow renders in a row before SKIP
const SMOOTH_AFTER_HITS = 10;   // on-time renders in a row before leaving SKIP

export class DayPlayer {
    private source: GopSource;
    private prebuffer: Prebuffer;

    private playing = false;
    private gapModeVal: GapMode = "blank";
    private speed = 1;
    private loopVal: { start: number; end: number } | null = null;
    private destroyed = false;
    private playWall: number;
    private shownWall: number;

    private mode: "smooth" | "skip" = "smooth";
    private consecMiss = 0;
    private consecHit = 0;
    private seekPending = false;

    private renderInFlight = false;
    private renderStartedAt = 0;
    private renderTargetWall = 0;
    private renderToken = 0;
    private lastTick = 0;

    private rafId: number | undefined;
    private lastEmittedWall = -1;
    private lastStatus: PlayStatus = "paused";
    private lastSeeking = false;
    private lastDropping = false;

    onTime: ((wallMs: number) => void) | undefined;
    onStatus: ((s: PlayStatus) => void) | undefined;
    onSeeking: ((seeking: boolean) => void) | undefined;
    onDropping: ((dropping: boolean) => void) | undefined;
    onPending: (() => void) | undefined;

    constructor(
        public renderer: Renderer,
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
        this.prebuffer = new Prebuffer(this.source);
        this.playWall = dayStartMs;
        this.shownWall = dayStartMs - this.frameStep;
        if (typeof requestAnimationFrame !== "undefined") this.rafId = requestAnimationFrame(this.tick);
    }

    private get comp(): number { return this.source.comp; }
    private get frameStep(): number { return this.source.frameStep; }
    private get cadence(): number { return 1000 / (FPS * this.speed); } // real ms between frames

    // ============================ public API ============================
    seekTo(wall: number): void { if (this.destroyed) return; this.jump(wall); this.log("SEEK", Math.round(this.playWall)); }
    play(): void { if (!this.destroyed && !this.playing) { this.playing = true; this.log("PLAY"); } }
    pause(): void { if (this.playing) { this.playing = false; this.log("PAUSE"); } }
    togglePlay(): void { if (this.playing) this.pause(); else this.play(); }
    setSpeed(s: number): void { this.speed = s > 0 ? s : 1; }
    setLoop(start: number, end: number): void { this.loopVal = { start, end }; }
    clearLoop(): void { this.loopVal = null; }
    setGapMode(m: GapMode): void { this.gapModeVal = m; }
    invalidateIndex(): void { this.source.clearIndex(); }
    nudge(deltaMs: number): void { this.seekTo(this.playWall + deltaMs); }
    seekTarget(): number { return this.playWall; }
    currentWall(): number { return this.playWall; }
    teardown(): void {
        this.destroyed = true;
        this.renderToken++;
        if (this.rafId != null && typeof cancelAnimationFrame !== "undefined") { try { cancelAnimationFrame(this.rafId); } catch { /* */ } }
        this.rafId = undefined;
    }

    get playStatus(): PlayStatus { return this.lastStatus; }
    get wantsPlay(): boolean { return this.playing; }
    get compression(): number { return this.comp; }
    get loop(): { start: number; end: number } | null { return this.loopVal; }
    get gapMode(): GapMode { return this.gapModeVal; }
    get pendingGopTimes(): number[] { return this.source.pendingGopTimes; }
    bufferedWallRanges(): { start: number; end: number }[] { return this.source.bufferedWallRanges(); }
    get ranges(): { start: number; end: number }[] { return this.source.ranges; }
    set ranges(r: { start: number; end: number }[]) { this.source.setRanges(r); }

    // ============================ the loop ============================
    private tick = (): void => {
        if (this.destroyed) return;
        try { this.step(); } catch (e) { console.error("[player] step error", e); }
        this.rafId = requestAnimationFrame(this.tick);
    };

    private step(): void {
        const now = Date.now();
        const dt = this.lastTick ? Math.min(250, now - this.lastTick) : 0;
        this.lastTick = now;

        // Advance the playhead at real-time × comp × speed (this is where the speed factor is
        // applied). EXCEPTION: in SMOOTH while a render is still in flight we HOLD (don't
        // advance) — that's the one grace for a slow frame, so playback just slows and shows
        // every frame. In SKIP we keep advancing even while rendering, so frames get dropped.
        if (this.playing) {
            const holding = this.mode === "smooth" && this.renderInFlight;
            if (!holding) {
                this.playWall = this.clampWall(this.playWall + dt * this.comp * this.speed);
                if (this.loopVal && this.playWall >= this.loopVal.end) { this.jump(this.loopVal.start); return; }
                if (!this.source.coveredAt(this.playWall)) { this.onGap(); this.emit(); return; }
            }
        }

        // One render at a time. If the last is still running, wait — enforce MAX_WAIT, after
        // which we abandon that frame and show the "missing" card.
        if (this.renderInFlight) {
            if (now - this.renderStartedAt > MAX_WAIT_MS) {
                this.renderer.drawMissing(this.renderTargetWall);
                this.completeRender(false);
            }
            this.prebuffer.pump(this.playWall);
            this.emit();
            return;
        }

        // Paused: just make sure the sought frame gets shown, then idle.
        if (!this.playing) {
            if (this.seekPending) this.beginRender(this.playWall);
            this.prebuffer.pump(this.playWall);
            this.emit();
            return;
        }

        // Render the frame at the current playhead.
        this.beginRender(this.playWall);
        this.prebuffer.pump(this.playWall);
        this.emit();
    }

    private beginRender(target: number): void {
        this.renderInFlight = true;
        this.renderStartedAt = Date.now();
        this.renderTargetWall = target;
        const token = ++this.renderToken;
        void this.drawFrameAt(target).then(hit => { if (token === this.renderToken && !this.destroyed) this.completeRender(hit); });
    }

    // Resolve the GOP + frame index for `wall` and draw it. Async: the cache decodes on a
    // miss, which is exactly the wait the clock paces around. Returns whether a frame drew.
    private async drawFrameAt(wall: number): Promise<boolean> {
        const gop = await this.source.gopForWall(wall);
        if (!gop) return false;
        // No-change (static) span: it has no video of its own. While PLAYING in skip mode we fast-
        // forward to the next real activity; but if there's none ahead (or we're paused, or in
        // blank mode) we still SHOW the scene — repeat the referenced frame with a ticking clock —
        // rather than freezing on a blank screen. This also fetches the ref GOP (so it loads).
        if (this.source.isNoChange(gop)) {
            if (this.playing && this.gapModeVal === "skip") {
                const next = await this.source.nextActiveStart(gop.e + 1);
                if (next != null) { this.jump(next); return false; } // jump supersedes this render
                // no activity ahead -> fall through and show the static scene instead of pausing
            }
            const ref = await this.source.gopForWall(this.source.refOf(gop));
            if (!ref || this.source.isNoChange(ref)) return false;
            const bmp = await getFrame(this.source, ref, ref.n - 1);
            if (!bmp) return false;
            this.renderer.drawImage(bmp, wall, "no activity");
            return true;
        }
        const walls = this.source.frameWalls(gop, gop.n);
        let fi = 0;
        for (let i = 0; i < walls.length; i++) {
            if (walls[i] <= wall) fi = i;
            else break;
        }
        const frame = await getFrame(this.source, gop, fi);
        if (!frame) return false;
        this.renderer.drawImage(frame, walls[fi]);
        return true;
    }

    private completeRender(hit: boolean): void {
        const onTime = hit && (Date.now() - this.renderStartedAt) <= this.cadence;
        const wasSeek = this.seekPending;
        this.renderInFlight = false;
        if (hit) this.shownWall = this.renderTargetWall; // playWall advances in step(), not here
        this.seekPending = false;
        if (this.mode === "smooth") {
            // A render slower than the frame budget is a "miss" — couldn't sustain real time.
            if (onTime || wasSeek) { this.consecHit++; this.consecMiss = 0; }
            else if (++this.consecMiss >= SKIP_AFTER_MISSES) { this.consecHit = 0; this.enterSkip(); }
            else this.consecHit = 0;
        } else {
            if (onTime) { if (++this.consecHit >= SMOOTH_AFTER_HITS) this.exitSkip(); }
            else this.consecHit = 0;
        }
    }

    // Coverage gap while playing (playWall already advanced into it): skip jumps to the next
    // range; blank paints the missing card and keeps advancing.
    private onGap(): void {
        if (this.gapModeVal === "skip") {
            const next = this.source.nextRangeStart(this.playWall);
            if (next != null) { this.jump(next); this.log("SKIPGAP", Math.round(next)); }
            else { this.playing = false; this.log("END"); }
            return;
        }
        this.shownWall = this.playWall;
        this.renderer.drawMissing(this.playWall);
        if (this.source.nextRangeStart(this.playWall) == null && !this.source.hasFootageAhead(this.playWall)) { this.playing = false; this.log("END"); }
    }

    private enterSkip(): void { this.mode = "skip"; this.consecHit = 0; this.log("SKIP"); }
    private exitSkip(): void { this.mode = "smooth"; this.consecMiss = 0; this.consecHit = 0; this.shownWall = this.playWall; this.log("SMOOTH"); }

    // A seek / loop-wrap / gap-skip: move the playhead, abandon any outstanding render, and
    // render the new target immediately. The cache keeps decoded GOPs, so seeking back is fast.
    private jump(wall: number): void {
        this.playWall = this.clampWall(wall);
        this.shownWall = this.playWall - this.frameStep;
        this.seekPending = true;
        this.mode = "smooth";
        this.consecMiss = 0;
        this.consecHit = 0;
        this.renderToken++;
        this.renderInFlight = false;
        this.source.cancelInflight();
    }

    private clampWall(w: number): number { return Math.max(this.dayStartMs, Math.min(this.source.spanEndMs - 1, w)); }

    // ============================ emit ============================
    private emit(): void {
        const w = Math.round(this.playWall);
        if (w !== this.lastEmittedWall) { this.lastEmittedWall = w; this.onTime?.(this.playWall); }
        const status: PlayStatus = !this.source.ranges.length ? "unavailable"
            : this.seekPending ? (this.playing ? "waiting" : "paused")
                : this.playing ? "playing" : "paused";
        if (status !== this.lastStatus) { this.lastStatus = status; this.onStatus?.(status); }
        if (this.seekPending !== this.lastSeeking) { this.lastSeeking = this.seekPending; this.onSeeking?.(this.seekPending); }
        const dropping = this.mode === "skip" && this.playing;
        if (dropping !== this.lastDropping) { this.lastDropping = dropping; this.onDropping?.(dropping); }
    }

    private log(ev: string, arg?: string | number): void {
        try {
            pushFsmEntry({
                ts: Date.now(), ev, arg, from: this.lastStatus, to: this.lastStatus,
                ctx: {
                    playing: this.playing, mode: this.mode, status: this.lastStatus,
                    playWall: Math.round(this.playWall), shownWall: Math.round(this.shownWall),
                    speed: this.speed, level: this.level, comp: this.comp,
                    consecMiss: this.consecMiss, consecHit: this.consecHit, seekPending: this.seekPending,
                    inFlight: this.api.outstandingGops, covered: this.source.coveredAt(this.playWall),
                    loop: this.loopVal ? `${Math.round(this.loopVal.start)}-${Math.round(this.loopVal.end)}` : null,
                },
            });
        } catch { /* */ }
    }
}
