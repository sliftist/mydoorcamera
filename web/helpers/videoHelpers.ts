// Day-based MSE player that we fully drive (no native controls), structured as an
// EXPLICIT STATE MACHINE so the many interacting concerns (seek/scrub, play/pause,
// live streaming, background buffering, stall recovery) compose deterministically
// instead of racing.
//
// Discipline (see dispatch()):
//   1. APPLY  — the event mutates `ctx` ONLY (intent, intendedWall, tokens, …). No DOM/network.
//   2. DECIDE — a pure function picks the next state from the (now-coherent) ctx.
//   3. EFFECTS— idempotent side-effects for the new state; async work is tokenized and
//               re-enters as NEW events (never awaited inline inside dispatch).
//   4. syncOutputs — fire onStatus/onSeeking only on change.
//   5. LOG    — append a transition entry (scalars only) to the module-level ring buffer.
//
// Because intent + intendedWall + tokens are coherent before DECIDE, "play from the
// stale current frame" and "stale GOP seeks the video backward" are structurally
// impossible. The single seek "pump" renders one frame at a time, always chasing the
// latest intendedWall; a per-target fetchToken drops results for abandoned targets.

import { CameraApi, GopEntry } from "./api";
import { splitFramedNals } from "../../src/annexb";
import { H264toMP4 } from "mp4-typescript";
import { FPS } from "../../src/config";
import { pushFsmEntry } from "./playerLog";

export type PlayStatus = "playing" | "paused" | "waiting" | "unavailable";

type FsmState = "idle" | "seeking" | "paused" | "playing" | "waiting" | "unavailable" | "live" | "destroyed";

type FsmEvent =
    | { type: "SEEK"; wall: number }
    | { type: "PLAY" }
    | { type: "PAUSE" }
    | { type: "SET_SPEED"; s: number }
    | { type: "SET_CATCHUP"; m: "rate" | "compress" }
    | { type: "START_LIVE" }
    | { type: "STOP_LIVE" }
    | { type: "INVALIDATE_INDEX" }
    | { type: "TEARDOWN" }
    | { type: "FRAME_SHOWN"; wall: number; token: number }
    | { type: "FRAME_FETCH_FAILED"; token: number }
    | { type: "UNCOVERED"; wall: number }
    | { type: "PLAYBACK_STARTED" }
    | { type: "PLAYBACK_BLOCKED" }
    | { type: "TIME_TICK"; wall: number }
    | { type: "STALL_DETECTED" }
    | { type: "RATE_TICK" }
    | { type: "SET_LOOP"; loop: { start: number; end: number } | null };

interface Ctx {
    state: FsmState;
    intent: "play" | "pause";   // what the user wants
    intendedWall: number;        // authoritative target position (wall ms)
    shownWall: number;           // frame the pump has actually rendered (-1 = none)
    pumpGen: number;             // bump to supersede the whole pump loop (live enter/exit, teardown)
    fetchToken: number;          // bump per new SEEK target; stale per-GOP completions are dropped
    pumping: boolean;            // a pump loop is currently running
    speed: number;               // review playback speed (1/16 .. 16)
    live: boolean;
    liveFactor: number;          // live catch-up factor (>1 = catching up)
    catchupMode: "rate" | "compress";
    status: PlayStatus;          // last emitted PlayStatus
    seekingFlag: boolean;        // last emitted onSeeking value
    loop: { start: number; end: number } | null; // loop-region playback (wall ms); null = no loop
    destroyed: boolean;
}

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
const FAIL_RETRY_MS = 200;      // pacing when a seek-frame fetch fails (e.g. disconnected) so we don't spin
const LOG_HEARTBEAT_MS = 1500;  // throttle for logging high-frequency unchanged ticks

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

    private ctx: Ctx;
    private prebufferTimer: ReturnType<typeof setTimeout> | undefined; // deferred trailing prebuffer (paused seeks)
    private pendingActions: string[] = [];  // side-effects taken during the current dispatch (for the log)
    private lastHeartbeat = 0;

    // ---- live infrastructure (kept; summarized into the log only as scalars) ----
    private firstLive = true;
    private lastReceivedEnd = 0; // max end-time of any GOP received from the live stream (real wall ms)
    private minBuffer = Infinity;      // buffer trough since the last rate tick
    private rateTimer: ReturnType<typeof setInterval> | undefined;
    private liveCursorSec = 0;          // MSE seconds where the next live GOP is appended
    private liveFramesTotal = 0;        // frames appended into the live timeline
    private liveCheckpoints: { mse: number; frames: number }[] = []; // (mseEnd, cumFrames) per GOP
    private liveBase = { mse: 0, frames: 0 };  // origin for the checkpoint map (advances as old checkpoints are pruned)
    private liveStartWall = 0;          // real wall ms of the first live frame (playhead display only)
    private liveChain: Promise<void> = Promise.resolve(); // serializes live appends so the cursor never races
    private liveOp: Promise<void> = Promise.resolve();    // current start/stop-live async op (awaited by public methods)

    private wdLastTime = -1;            // stall watchdog
    private wdStall = 0;
    private watchdogTimer: ReturnType<typeof setInterval> | undefined;

    private spanEndMs = 0;              // end of the navigable period (day/month/year)

    onStatus: ((s: PlayStatus) => void) | undefined;
    onTime: ((wallMs: number) => void) | undefined;
    onRate: ((rate: number) => void) | undefined;
    onBuffer: ((sec: number) => void) | undefined;
    onSeeking: ((seeking: boolean) => void) | undefined; // true while chasing a seek target we haven't shown yet

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
        this.ctx = {
            state: "idle", intent: "pause", intendedWall: dayStartMs, shownWall: -1,
            pumpGen: 0, fetchToken: 0, pumping: false, speed: 1, live: false,
            liveFactor: 1, catchupMode: "rate", status: "paused", seekingFlag: false, loop: null, destroyed: false,
        };
        this.video.addEventListener("timeupdate", this.onVideoTimeUpdate);
        this.video.addEventListener("playing", this.onVideoPlaying);
        this.video.addEventListener("canplay", this.onVideoPlaying);
        this.video.addEventListener("waiting", this.onVideoWaiting);
        this.video.addEventListener("stalled", this.onVideoWaiting);
        this.watchdogTimer = setInterval(() => this.watchdog(), 500);
        this.scheduleFrameCb(); // per-frame playhead updates (the video tells us when it shows a frame)
    }

    // ============================ public API (thin dispatchers) ============================
    seekTo(wall: number): void { this.dispatch({ type: "SEEK", wall }); }
    play(): void { this.dispatch({ type: "PLAY" }); }
    pause(): void { this.dispatch({ type: "PAUSE" }); }
    togglePlay(): void { if (this.ctx.intent === "play") this.pause(); else this.play(); }
    setSpeed(s: number): void { this.dispatch({ type: "SET_SPEED", s }); }
    setCatchupMode(m: "rate" | "compress"): void { this.dispatch({ type: "SET_CATCHUP", m }); }
    setLoop(start: number, end: number): void { this.dispatch({ type: "SET_LOOP", loop: { start, end } }); }
    clearLoop(): void { this.dispatch({ type: "SET_LOOP", loop: null }); }
    get loop(): { start: number; end: number } | null { return this.ctx.loop; }
    invalidateIndex(): void { this.dispatch({ type: "INVALIDATE_INDEX" }); }
    async startLive(): Promise<void> { this.dispatch({ type: "START_LIVE" }); await this.liveOp; }
    async stopLive(): Promise<void> { this.dispatch({ type: "STOP_LIVE" }); await this.liveOp; }
    teardown(): void { this.dispatch({ type: "TEARDOWN" }); }
    nudge(deltaMs: number): void { this.seekTo(this.ctx.intendedWall + deltaMs); }
    seekTarget(): number { return this.ctx.intendedWall; }

    get playStatus(): PlayStatus { return this.ctx.status; }
    get wantsPlay(): boolean { return this.ctx.intent === "play"; }
    get compression(): number { return this.comp; }   // real seconds per playback second (30^level)
    get catchup(): "rate" | "compress" { return this.ctx.catchupMode; }
    get isLive(): boolean { return this.ctx.live; }

    // ============================ the state machine ============================
    private dispatch(ev: FsmEvent): void {
        if (this.ctx.destroyed && ev.type !== "TEARDOWN") return;
        const from = this.ctx.state;
        this.applyEvent(ev);
        const to = this.decide(from, ev);
        this.ctx.state = to;
        try { this.runEffects(from, to, ev); } catch (e) { console.error("[fsm] effect error", e); }
        this.syncOutputs();
        this.logDispatch(ev, from, to);
    }

    // 1. APPLY — mutate ctx only; no side effects.
    private applyEvent(ev: FsmEvent): void {
        const c = this.ctx;
        switch (ev.type) {
            case "SEEK":
                if (c.live) return; // live owns the playhead
                c.intendedWall = Math.max(this.dayStartMs, Math.min(this.spanEndMs - 1, ev.wall));
                c.fetchToken++;     // a new target drops any in-flight stale fetch
                break;
            case "PLAY": if (!c.live) c.intent = "play"; break;
            case "PAUSE": if (!c.live) c.intent = "pause"; break;
            case "SET_SPEED": c.speed = ev.s; break;
            case "SET_CATCHUP": c.catchupMode = ev.m; break;
            case "SET_LOOP": c.loop = ev.loop; break;
            case "START_LIVE": c.live = true; c.intent = "play"; c.pumpGen++; break;
            case "STOP_LIVE": c.live = false; c.intent = "pause"; c.pumpGen++; c.shownWall = -1; c.liveFactor = 1; break;
            case "INVALIDATE_INDEX": if (c.state === "unavailable") { c.shownWall = -1; c.fetchToken++; } break;
            case "TEARDOWN": c.destroyed = true; c.pumpGen++; break;
            case "FRAME_SHOWN": if (ev.token === c.fetchToken) c.shownWall = ev.wall; break;
            case "TIME_TICK": if (c.state === "playing" && !c.live) c.intendedWall = ev.wall; break;
            default: break; // FRAME_FETCH_FAILED / UNCOVERED / PLAYBACK_* / STALL_DETECTED / RATE_TICK
        }
    }

    // 2. DECIDE — pure: next state from the current (post-APPLY) ctx.
    private decide(from: FsmState, ev: FsmEvent): FsmState {
        const c = this.ctx;
        if (c.destroyed) return "destroyed";
        switch (ev.type) {
            case "TEARDOWN": return "destroyed";
            case "START_LIVE": return "live";
            case "STOP_LIVE": return "paused";
            case "SET_SPEED": case "SET_CATCHUP": case "SET_LOOP": return from;
            case "INVALIDATE_INDEX": return from === "unavailable" ? "seeking" : from;
        }
        if (c.live || from === "live") return "live"; // live ignores SEEK/PLAY/PAUSE/etc.
        switch (ev.type) {
            case "SEEK": return "seeking";
            case "PLAY":
                if (from === "playing") return "playing";
                if (from === "seeking") return "seeking"; // stay; pump starts playback at settle
                return "waiting";
            case "PAUSE": return "paused";
            case "FRAME_SHOWN":
                if (ev.token !== c.fetchToken || c.shownWall !== c.intendedWall) return from; // stale / not the target
                return c.intent === "play" ? "waiting" : "paused";
            case "FRAME_FETCH_FAILED": return from;          // pump retries
            case "UNCOVERED": return "unavailable";
            case "PLAYBACK_STARTED":
                return (from === "waiting" || from === "playing") && !this.video.paused && this.video.readyState >= 3 ? "playing" : from;
            case "PLAYBACK_BLOCKED": return from === "playing" ? "waiting" : from;
            case "TIME_TICK":
                if (from === "waiting" && !this.video.paused && this.video.readyState >= 3) return "playing";
                return from;
            default: return from; // STALL_DETECTED, RATE_TICK
        }
    }

    // 3. EFFECTS — idempotent; start async work that re-enters as new events.
    private runEffects(from: FsmState, to: FsmState, ev: FsmEvent): void {
        if (ev.type === "TIME_TICK") this.onTime?.(ev.wall);

        switch (ev.type) {
            case "SET_SPEED": if (!this.ctx.live) { try { this.video.playbackRate = this.ctx.speed; } catch { /* */ } } return;
            case "SET_CATCHUP": this.applyLiveRate(); return;
            case "TEARDOWN": this.doTeardown(); return;
            case "START_LIVE": this.liveOp = this.doStartLive(); return;
            case "STOP_LIVE": this.liveOp = this.doStopLive(); break; // then fall into "paused" entry
            case "STALL_DETECTED": this.jumpOverGap(); return;
            case "RATE_TICK": this.tickRate(); return;
            case "INVALIDATE_INDEX": this.clearIndexCaches(); this.action("clearIndex"); break;
        }

        if (to === "live") { if (ev.type === "TIME_TICK") this.liveTick(); return; }

        switch (to) {
            case "seeking":
                if (this.prebufferTimer) { clearTimeout(this.prebufferTimer); this.prebufferTimer = undefined; }
                try { this.video.pause(); } catch { /* */ }
                this.action("videoPause");
                void this.runPump();
                break;
            case "waiting":
                if (from !== "waiting") void this.startPlaybackFrom(this.ctx.intendedWall);
                break;
            case "playing":
                if (ev.type === "TIME_TICK") { void this.bufferAhead(ev.wall); this.evictBefore(this.video.currentTime - 90); }
                else if (from !== "playing") void this.bufferAhead(this.ctx.intendedWall);
                break;
            case "paused":
                if (from !== "paused") { try { this.video.pause(); } catch { /* */ } this.action("videoPause"); }
                if (from === "seeking") this.schedulePrebuffer(this.ctx.intendedWall);
                break;
            case "unavailable":
                try { this.video.pause(); } catch { /* */ }
                break;
        }
    }

    // 4. emit derived public signals on change.
    private syncOutputs(): void {
        const status = this.statusFor(this.ctx.state);
        if (status !== this.ctx.status) { this.ctx.status = status; this.onStatus?.(status); }
        const seeking = this.ctx.state === "seeking";
        if (seeking !== this.ctx.seekingFlag) { this.ctx.seekingFlag = seeking; this.onSeeking?.(seeking); }
    }

    private statusFor(s: FsmState): PlayStatus {
        switch (s) {
            case "playing": return "playing";
            case "waiting": return "waiting";
            case "unavailable": return "unavailable";
            case "seeking": return this.ctx.intent === "play" ? "waiting" : "paused";
            case "live": return (!this.video.paused && this.video.readyState >= 3) ? "playing" : "waiting";
            default: return "paused"; // paused / idle / destroyed
        }
    }

    // 5. logging — scalars only; throttle high-frequency unchanged ticks.
    private action(s: string): void { this.pendingActions.push(s); }
    private logDispatch(ev: FsmEvent, from: FsmState, to: FsmState): void {
        const actions = this.pendingActions; this.pendingActions = [];
        const noisy = ev.type === "TIME_TICK" || ev.type === "RATE_TICK";
        const changed = from !== to;
        const now = Date.now();
        let shouldLog = !noisy || changed;
        if (noisy && !changed) { if (now - this.lastHeartbeat >= LOG_HEARTBEAT_MS) { shouldLog = true; this.lastHeartbeat = now; } }
        if (!shouldLog) return;
        pushFsmEntry({ ts: now, ev: ev.type, arg: this.shortArg(ev), from, to, ctx: this.ctxSnapshot(), actions: actions.length ? actions : undefined });
    }
    private shortArg(ev: FsmEvent): string | number | undefined {
        switch (ev.type) {
            case "SEEK": case "FRAME_SHOWN": case "UNCOVERED": case "TIME_TICK": return Math.round((ev as any).wall);
            case "SET_SPEED": return (ev as any).s;
            case "SET_CATCHUP": return (ev as any).m;
            case "FRAME_FETCH_FAILED": return (ev as any).token;
            default: return undefined;
        }
    }
    private ctxSnapshot(): Record<string, unknown> {
        let buffered = "";
        try {
            const b = this.sb?.buffered;
            if (b) { const parts: string[] = []; for (let i = 0; i < b.length && i < 4; i++) parts.push(`${b.start(i).toFixed(1)}-${b.end(i).toFixed(1)}`); if (b.length > 4) parts.push("…"); buffered = `[${parts.join(",")}]`; }
        } catch { /* */ }
        const c = this.ctx;
        return {
            intent: c.intent, status: c.status,
            intendedWall: Math.round(c.intendedWall), shownWall: Math.round(c.shownWall),
            curSec: +(this.video.currentTime || 0).toFixed(3), curWall: Math.round(this.currentWall()),
            speed: c.speed, level: this.level, comp: this.comp,
            live: c.live, liveFactor: +c.liveFactor.toFixed(3), catchup: c.catchupMode,
            pumping: c.pumping, pumpGen: c.pumpGen, fetchToken: c.fetchToken,
            bufAhead: +this.bufferedSec().toFixed(2), appended: this.appended.size,
            inFlight: this.api.outstandingGops, readyState: this.video.readyState, paused: this.video.paused,
            buffered,
        };
    }

    // ============================ DOM / timer -> events ============================
    private onVideoTimeUpdate = (): void => { if (!this.ctx.destroyed) this.dispatch({ type: "TIME_TICK", wall: this.currentWall() }); };
    private onVideoPlaying = (): void => { if (!this.ctx.destroyed) this.dispatch({ type: "PLAYBACK_STARTED" }); };
    private onVideoWaiting = (): void => { if (!this.ctx.destroyed) this.dispatch({ type: "PLAYBACK_BLOCKED" }); };

    // Drive onTime off actual presented frames (requestVideoFrameCallback) so the
    // playhead tracks real playback, not just the ~4Hz timeupdate event.
    private scheduleFrameCb(): void {
        const v: any = this.video;
        if (typeof v.requestVideoFrameCallback !== "function") return;
        const cb = () => {
            if (this.ctx.destroyed) return;
            const wall = this.currentWall();
            this.onTime?.(wall);
            // Loop-region playback: when playing reaches the loop end, jump back to its start.
            const lp = this.ctx.loop;
            if (lp && this.ctx.state === "playing" && !this.ctx.live && wall >= lp.end) this.seekTo(lp.start);
            v.requestVideoFrameCallback(cb);
        };
        v.requestVideoFrameCallback(cb);
    }

    // Stall watchdog: if we want to play but currentTime isn't advancing while there's
    // buffered data ahead (an MSE gap the browser won't cross), dispatch a stall.
    private watchdog(): void {
        const playingIntent = this.ctx.intent === "play" || this.ctx.live;
        if (!playingIntent || this.video.paused) { this.wdLastTime = this.video.currentTime; this.wdStall = 0; return; }
        const ct = this.video.currentTime;
        if (Math.abs(ct - this.wdLastTime) < 0.02) {
            if (++this.wdStall >= 2) { this.dispatch({ type: "STALL_DETECTED" }); this.wdStall = 0; }
        } else this.wdStall = 0;
        this.wdLastTime = ct;
    }

    // ============================ seek pump ============================
    // Single loop chasing the latest ctx.intendedWall; renders ONE frame at a time so
    // fast scrubbing never piles up requests. Stale per-target results (fetchToken
    // moved on) are discarded — no backward jump from a late GOP.
    private async runPump(): Promise<void> {
        if (this.ctx.pumping) return;
        const gen = this.ctx.pumpGen;
        this.ctx.pumping = true;
        try {
            while (this.ctx.pumpGen === gen && !this.ctx.live && this.ctx.shownWall !== this.ctx.intendedWall) {
                const t = this.ctx.intendedWall;
                const tok = this.ctx.fetchToken;
                const res = await this.renderFrameAt(t, tok);
                if (this.ctx.pumpGen !== gen || this.ctx.live) break;
                if (tok !== this.ctx.fetchToken) continue;           // target moved mid-fetch -> chase newest
                if (res === "uncovered") { this.dispatch({ type: "UNCOVERED", wall: t }); break; }
                if (res === "failed") { this.dispatch({ type: "FRAME_FETCH_FAILED", token: tok }); await this.delay(FAIL_RETRY_MS); continue; }
                this.dispatch({ type: "FRAME_SHOWN", wall: t, token: tok }); // APPLY sets shownWall -> loop exits
            }
        } finally { this.ctx.pumping = false; }
    }

    private async renderFrameAt(wall: number, _tok: number): Promise<"shown" | "uncovered" | "failed"> {
        if (this.ctx.live) return "failed";
        if (!this.coveredAt(wall)) return "uncovered";
        let target = await this.gopAt(wall);
        // Coverage says there's footage here but our cached index ends well before it —
        // the cache is stale (live edge). Re-fetch once and retry.
        if (target && wall - target.g.e > Math.max(2000, this.gopDurMs(target.g))) {
            this.clearIndexCaches();
            target = await this.gopAt(wall);
        }
        if (!target) return "uncovered";
        try {
            this.action(`fetchGop(${Math.round(wall)})`);
            await this.ensureSourceBuffer(target);
            await this.appendGop(target.hh, target.g);
            await this.seekVideo(this.internalSec(Math.max(wall, target.g.t)));
            this.onTime?.(this.currentWall());
            return "shown";
        } catch { return "failed"; }
    }

    private seekVideo(sec: number): Promise<void> {
        return new Promise(res => {
            let done = false;
            const finish = () => { if (done) return; done = true; this.video.removeEventListener("seeked", finish); res(); };
            this.video.addEventListener("seeked", finish, { once: true });
            try { this.video.currentTime = sec; this.action(`setCurrentTime(${sec.toFixed(2)})`); } catch { finish(); return; }
            setTimeout(finish, 400); // never hang if 'seeked' doesn't fire
        });
    }

    private delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
    private schedulePrebuffer(wall: number): void {
        if (this.prebufferTimer) clearTimeout(this.prebufferTimer);
        this.prebufferTimer = setTimeout(() => { void this.bufferAhead(wall); }, PREBUFFER_DELAY_MS);
    }

    // ============================ playback ============================
    private async startPlaybackFrom(wall: number): Promise<void> {
        if (this.ctx.intent !== "play" || this.ctx.live) return;
        if (!this.coveredAt(wall)) { this.dispatch({ type: "UNCOVERED", wall }); return; }
        const target = await this.gopAt(wall);
        if (!target) { this.dispatch({ type: "UNCOVERED", wall }); return; }
        // Append only the GOP at the play point, then start immediately — the rest streams
        // in the background (TIME_TICK keeps buffering ahead), so play feels instant.
        this.action(`fetchGop(${Math.round(wall)})`);
        await this.ensureSourceBuffer(target);
        await this.appendGop(target.hh, target.g);
        if (this.ctx.intent !== "play" || this.ctx.live) return;
        if (Math.abs(this.currentWall() - wall) > 1500) { try { this.video.currentTime = this.internalSec(wall); } catch { /* */ } }
        try { this.video.playbackRate = this.ctx.speed; } catch { /* */ }
        try { await this.video.play(); this.action("videoPlay"); } catch { this.dispatch({ type: "PLAYBACK_BLOCKED" }); return; }
        this.dispatch({ type: "PLAYBACK_STARTED" });
    }

    // ============================ buffering primitives (unchanged) ============================
    internalSec(wall: number): number { return (wall - this.dayStartMs) / 1000 / this.comp; }
    currentWall(): number {
        if (this.ctx.live) return this.liveStartWall + (this.liveFramesAt(this.video.currentTime) / FPS) * 1000;
        return this.dayStartMs + this.video.currentTime * 1000 * this.comp;
    }
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

    bufferedWallRanges(): { start: number; end: number }[] {
        const b = this.sb?.buffered;
        if (!b) return [];
        const out: { start: number; end: number }[] = [];
        for (let i = 0; i < b.length; i++) out.push({ start: this.dayStartMs + b.start(i) * 1000 * this.comp, end: this.dayStartMs + b.end(i) * 1000 * this.comp });
        return out;
    }

    private ensureLevelLoaded(): Promise<void> {
        if (!this.levelReady) this.levelReady = (async () => {
            try { const r = await this.api.getLevelIndex(this.level, this.dayStartMs, this.spanEndMs); this.levelGops = ((r && r.gops) || []).slice().sort((a, b) => a.t - b.t); }
            catch { this.levelGops = []; }
        })();
        return this.levelReady;
    }
    private coveredAt(wall: number): boolean { return this.ranges.some(r => wall >= r.start && wall <= r.end + 500); }
    private clearIndexCaches(): void { this.hourCache.clear(); this.levelReady = undefined; }

    private async ensureSourceBuffer(target: { hh: string; g: GopEntry }): Promise<void> {
        if (this.sb) return;
        const nals = await this.fetchNals(target.hh, target.g);
        this.ms = new MediaSource();
        this.video.src = URL.createObjectURL(this.ms);
        await this.waitSourceOpen(this.ms);
        this.sb = this.ms.addSourceBuffer(`video/mp4; codecs="${codecFromSps(nals)}"`);
        await this.appendGop(target.hh, target.g, nals);
    }

    private waitSourceOpen(ms: MediaSource): Promise<void> {
        return new Promise<void>((res, rej) => {
            const ok = () => { clearTimeout(t); res(); };
            const t = setTimeout(() => { ms.removeEventListener("sourceopen", ok); rej(new Error("sourceopen timeout")); }, 3000);
            ms.addEventListener("sourceopen", ok, { once: true });
        });
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
        const data = this.level > 0
            ? await this.api.getLevelGopData(this.level, g.t, g.f, g.o, g.l)
            : await this.api.getGopData(this.dayParts, g.f, g.o, g.l);
        return splitFramedNals(Buffer.from(data));
    }

    private isBuffered(sec: number): boolean {
        const b = this.sb?.buffered;
        if (!b) return false;
        for (let i = 0; i < b.length; i++) if (sec >= b.start(i) - 0.05 && sec < b.end(i) + 0.1) return true;
        return false;
    }

    // Wall time of the GOP immediately following `g` — used to mux GOPs contiguously
    // (stretch the last frame to the next keyframe) so playback doesn't stall on the
    // few-ms capture jitter at each seam.
    private async nextStartWall(g: GopEntry): Promise<number | undefined> {
        if (this.level > 0) {
            await this.ensureLevelLoaded();
            for (const x of this.levelGops) if (x.t > g.t) return x.t;
            return undefined;
        }
        for (let hn = this.hourNumOf(g.t); hn <= 23; hn++) {
            for (const x of await this.ensureHour(hn)) if (x.t > g.t) return x.t;
        }
        return undefined;
    }
    private async muxFrameDur(g: GopEntry): Promise<number> {
        const nominalSec = g.n / FPS;
        const next = await this.nextStartWall(g);
        if (next == null) return 1 / FPS;
        const spanSec = (next - g.t) / 1000 / this.comp;
        return spanSec > 0 && spanSec <= nominalSec * 2 ? spanSec / g.n : 1 / FPS;
    }

    private async appendGop(hh: string, g: GopEntry, nals?: Buffer[]): Promise<void> {
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

    private async runBounded<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
        let i = 0;
        const worker = async () => { while (i < items.length) await fn(items[i++]); };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    }

    // Prefetch GOPs ahead concurrently and keep a target number buffered into the
    // future — both scaled by playback speed (faster playback consumes faster).
    private bufferingAhead = false;
    private async bufferAhead(fromWall: number): Promise<void> {
        if (this.bufferingAhead || this.ctx.live) return;
        this.bufferingAhead = true;
        try {
            const rate = Math.max(1, this.ctx.speed);
            const target = Math.min(200, Math.round(BUFFER_TARGET_GOPS * rate));
            const batch = Math.min(16, Math.round(BUFFER_BATCH_GOPS * rate));
            const list = await this.gopsAhead(fromWall, target);
            await this.runBounded(list, batch, x => this.appendGop(x.hh, x.g).catch(() => { /* */ }));
        } finally { this.bufferingAhead = false; }
    }

    private evictBefore(sec: number): void {
        if (!this.sb || this.sb.updating || this.queue.length || sec <= 0) return;
        try { if (this.sb.buffered.length && this.sb.buffered.start(0) < sec - 5) this.sb.remove(0, sec); } catch { /* */ }
    }

    // ============================ live streaming ============================
    private async doStartLive(): Promise<void> {
        this.firstLive = true;
        this.lastReceivedEnd = 0; this.ctx.liveFactor = 1; this.minBuffer = Infinity;
        this.liveCursorSec = 0; this.liveFramesTotal = 0; this.liveCheckpoints = []; this.liveBase = { mse: 0, frames: 0 };
        this.liveStartWall = 0; this.liveChain = Promise.resolve();
        this.teardownMse(); // fresh timeline starting at the live edge
        if (this.rateTimer) clearInterval(this.rateTimer);
        this.rateTimer = setInterval(() => this.dispatch({ type: "RATE_TICK" }), 1000);
        try { await this.api.startStream(this.dayParts.join("/"), (meta, bytes) => void this.onLiveData(meta, bytes)); }
        catch (e) { this.ctx.live = false; this.ctx.state = "paused"; this.syncOutputs(); throw e; }
    }

    private async doStopLive(): Promise<void> {
        if (this.rateTimer) { clearInterval(this.rateTimer); this.rateTimer = undefined; }
        try { this.video.pause(); } catch { /* */ }
        try { this.video.playbackRate = this.ctx.speed; } catch { /* */ }
        this.onRate?.(1);
        this.onBuffer?.(0);
        try { await this.api.stopStream(); } catch { /* */ }
        this.teardownMse(); // drop the synthetic live timeline so review starts clean (and the loaded band is correct)
    }

    private applyLiveRate(): void {
        if (!this.ctx.live) return;
        try { this.video.playbackRate = this.ctx.catchupMode === "rate" ? this.ctx.liveFactor : 1; } catch { /* */ }
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
        if (!this.ctx.live) return Math.max(0, (this.lastReceivedEnd - this.currentWall()) / 1000);
        return Math.max(0, (this.liveFramesTotal - this.liveFramesAt(this.video.currentTime)) / FPS);
    }

    private liveTick(): void {
        const buf = this.bufferedSec();
        this.minBuffer = Math.min(this.minBuffer, buf);
        this.onBuffer?.(buf);
    }

    private onLiveData(meta: { t: number; e: number; n: number }, bytes: Uint8Array): void {
        if (!this.ctx.live) return;
        this.lastReceivedEnd = Math.max(this.lastReceivedEnd, meta.e);
        const nals = splitFramedNals(Buffer.from(bytes));
        this.liveChain = this.liveChain.then(() => this.appendLive(meta, nals)).catch(() => { /* */ });
    }

    private async appendLive(meta: { t: number; e: number; n: number }, nals: Buffer[]): Promise<void> {
        if (!this.ctx.live) return;
        await this.ensureSourceBufferWithNals(nals);
        if (!this.ctx.live || this.appended.has(meta.t)) return;
        this.appended.add(meta.t);
        // Append back-to-back on the synthetic timeline (no real-time gaps to stall on).
        const frameDur = this.ctx.catchupMode === "compress" ? 1 / (FPS * this.ctx.liveFactor) : 1 / FPS;
        const startSec = this.liveCursorSec;
        try {
            const mp4 = await H264toMP4({ buffer: nals, frameDurationInSeconds: frameDur, mediaStartTimeSeconds: startSec });
            await this.enqueue(Buffer.from(mp4.buffer));
        } catch { this.appended.delete(meta.t); return; }
        this.liveCursorSec = startSec + meta.n * frameDur;
        this.liveFramesTotal += meta.n;
        this.liveCheckpoints.push({ mse: this.liveCursorSec, frames: this.liveFramesTotal });
        if (this.liveCheckpoints.length > 4000) this.liveBase = this.liveCheckpoints.shift()!;
        if (!this.liveStartWall) this.liveStartWall = meta.t;
        this.onBuffer?.(this.bufferedSec());
        if (this.firstLive) {
            this.firstLive = false;
            try { this.video.currentTime = startSec; } catch { /* */ }
            try { this.video.playbackRate = this.ctx.catchupMode === "rate" ? this.ctx.liveFactor : 1; } catch { /* */ }
            this.video.play().catch(() => { /* */ });
        }
    }

    // Rate control, once per second, measured at the buffer trough. Target a 1-2s
    // backlog: above it ramp the catch-up factor up; below 1s ease back to real-time.
    private tickRate(): void {
        if (!this.ctx.live) return;
        const buf = isFinite(this.minBuffer) ? this.minBuffer : this.bufferedSec();
        this.minBuffer = Infinity;
        const reduceStep = () => Math.max(0.02, 0.25 * Math.max(0, this.ctx.liveFactor - 1));
        if (buf > 2) this.ctx.liveFactor = Math.min(4, this.ctx.liveFactor + 0.1);
        else if (buf < 1) this.ctx.liveFactor = Math.max(0.5, this.ctx.liveFactor - reduceStep());
        else if (this.ctx.liveFactor > 1.0001) this.ctx.liveFactor = Math.max(1, this.ctx.liveFactor - reduceStep());
        else if (this.ctx.liveFactor < 0.9999) this.ctx.liveFactor = Math.min(1, this.ctx.liveFactor + 0.02);
        if (this.ctx.catchupMode === "rate") { try { this.video.playbackRate = this.ctx.liveFactor; } catch { /* */ } }
        else { try { this.video.playbackRate = 1; } catch { /* */ } }
        this.onRate?.(this.ctx.liveFactor);
        this.evictBefore(this.video.currentTime - 15);
    }

    private jumpOverGap(): void {
        if (!this.sb || !this.sb.buffered.length) return;
        const ct = this.video.currentTime, b = this.sb.buffered;
        let target = -1;
        for (let i = 0; i < b.length; i++) {
            if (b.start(i) > ct + 0.02) { target = b.start(i); break; }
            if (ct <= b.end(i) + 0.02 && i + 1 < b.length) { target = b.start(i + 1); break; }
        }
        if (target >= 0) {
            this.action(`jumpGap(${ct.toFixed(2)}->${(target + 0.05).toFixed(2)})`);
            console.warn(`[player] stall watchdog jumped a buffer gap: ${ct.toFixed(2)}s -> ${(target + 0.05).toFixed(2)}s${this.ctx.live ? " (LIVE — falling behind)" : ""}`);
            try { this.video.currentTime = target + 0.05; void this.video.play(); } catch { /* */ }
        }
    }

    // ============================ teardown ============================
    private drainQueue(): void {
        for (const item of this.queue) item.resolve();
        this.queue = []; this.flushing = false;
    }
    private teardownMse(): void {
        try { this.video.pause(); this.video.removeAttribute("src"); this.video.load(); } catch { /* */ }
        this.ms = undefined; this.sb = undefined;
        this.appended.clear(); this.drainQueue();
    }
    private doTeardown(): void {
        if (this.prebufferTimer) clearTimeout(this.prebufferTimer);
        if (this.rateTimer) clearInterval(this.rateTimer);
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);
        try { void this.api.stopStream(); } catch { /* */ }
        this.video.removeEventListener("timeupdate", this.onVideoTimeUpdate);
        this.video.removeEventListener("playing", this.onVideoPlaying);
        this.video.removeEventListener("canplay", this.onVideoPlaying);
        this.video.removeEventListener("waiting", this.onVideoWaiting);
        this.video.removeEventListener("stalled", this.onVideoWaiting);
        try { this.video.pause(); this.video.removeAttribute("src"); this.video.load(); } catch { /* */ }
        this.ms = undefined; this.sb = undefined;
        this.appended.clear(); this.drainQueue(); this.hourCache.clear();
    }
}
