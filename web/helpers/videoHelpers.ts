// Self-driven day player: we decode H.264 ourselves with WebCodecs `VideoDecoder`
// and render to a <canvas> on a requestAnimationFrame loop, owning the playhead
// entirely. No MediaSource, no mp4 muxing, no fighting the browser's <video>.
//
// Because WE own the clock and only ever draw frames we actually have:
//   - playback can't stall — at the edge of footage we simply pause;
//   - gaps in the recording are handled explicitly (blank-with-timestamp or skip);
//   - live is trivial — feed the stream into the same decoder and draw the newest
//     frame, dropping backlog so it stays real-time.
//
// Structure is still an explicit STATE MACHINE for discrete events (seek/play/pause/
// live/teardown) so transitions are deterministic and logged (see dispatch()); the
// continuous work (advancing the playhead, decoding ahead, drawing) lives in the rAF
// loop and the decode pump, which emit FRAME_SHOWN back into the machine to settle
// seeks. The index/GOP plumbing (gopAt/ensureHour/gopsAhead/fetch) is unchanged.

import { CameraApi, GopEntry } from "./api";
import { accessUnitsFromGop, codecFromSps } from "./h264";
import { FPS } from "../../src/config";
import { clockHMS } from "./format";
import { pushFsmEntry } from "./playerLog";

export type PlayStatus = "playing" | "paused" | "waiting" | "unavailable";
export type GapMode = "blank" | "skip";

type FsmState = "idle" | "seeking" | "paused" | "playing" | "live" | "unavailable" | "destroyed";

type FsmEvent =
    | { type: "SEEK"; wall: number }
    | { type: "PLAY" }
    | { type: "PAUSE" }
    | { type: "SET_SPEED"; s: number }
    | { type: "SET_LOOP"; loop: { start: number; end: number } | null }
    | { type: "SET_GAP"; m: GapMode }
    | { type: "START_LIVE" }
    | { type: "STOP_LIVE" }
    | { type: "INVALIDATE_INDEX" }
    | { type: "TEARDOWN" }
    | { type: "FRAME_SHOWN"; wall: number; token: number }
    | { type: "FRAME_FETCH_FAILED"; token: number }
    | { type: "UNCOVERED"; wall: number }
    | { type: "PAUSE_AT_END" };

interface Ctx {
    state: FsmState;
    intent: "play" | "pause";
    shownWall: number;     // frame the loop has actually drawn (-1 = none)
    pumpGen: number;       // bump to supersede pumps / live (teardown, live enter/exit)
    fetchToken: number;    // bump per SEEK; stale GOP completions are dropped
    speed: number;         // review playback speed (multiplies real-time advance)
    live: boolean;
    gapMode: GapMode;
    loop: { start: number; end: number } | null;
    status: PlayStatus;
    seekingFlag: boolean;
    destroyed: boolean;
}

const DAY_MS = 24 * 3600 * 1000;
const DECODE_MAX_FRAMES = 90;     // hard cap on decoded VideoFrames held in memory (~3s @30fps)
const DECODE_AHEAD_FRAMES = 60;   // keep ~2s of frames decoded ahead of the playhead
const PRELOAD_PLAYBACK_SEC = 10;  // prefetch GOP *bytes* this many playback-seconds ahead (× speed)
const BYTES_CACHE_MAX = 64;       // hard cap on prefetched GOP byte buffers held
const LIVE_KEEP_FRAMES = 4;       // live: keep only the newest few decoded frames
const LOG_HEARTBEAT_MS = 1500;
const W: any = typeof window !== "undefined" ? window : {};

export class DayPlayer {
    private c2d: CanvasRenderingContext2D | null;
    private canvasSized = false;

    // ---- decode pipeline ----
    private decoder: any | undefined;          // VideoDecoder
    private decoderCodec = "";
    private decodeConfigured = false;
    private decoded: { wall: number; frame: any }[] = []; // VideoFrame[], sorted asc by wall
    private fedGops = new Set<number>();        // g.t of GOPs already fed to the decoder
    private feedWall = 0;                        // wall from which the decode pump takes the next GOP
    private fetchWall = 0;                        // wall up to which the prefetch pump has fetched bytes
    private bytesCache = new Map<number, Buffer>(); // prefetched GOP bytes (g.t -> bytes), awaiting decode
    private decoding = false;                    // decodeAhead re-entry guard
    private prefetching = false;                 // prefetchAhead re-entry guard
    private bufferGen = 0;                        // bumped on SEEK to abandon stale look-ahead

    private pendingGops = new Set<number>();    // GOP.t with a data fetch in flight (yellow markers)
    private fetched = new Map<number, { start: number; end: number }>(); // loaded GOP spans (green band)

    private hourCache = new Map<string, GopEntry[]>();
    private comp = 1;                            // 30^level: real-seconds advanced per playback-second
    private levelGops: GopEntry[] = [];
    private levelReady: Promise<void> | undefined;

    private ctx: Ctx;
    private playWall: number;                    // authoritative playhead (wall ms)
    private rafId: number | undefined;
    private lastTs = 0;
    private lastEmittedWall = -1;
    private pendingActions: string[] = [];
    private lastHeartbeat = 0;
    private spanEndMs = 0;

    // ---- live ----
    private liveChain: Promise<void> = Promise.resolve();
    private liveOp: Promise<void> = Promise.resolve();

    onStatus: ((s: PlayStatus) => void) | undefined;
    onTime: ((wallMs: number) => void) | undefined;
    onSeeking: ((seeking: boolean) => void) | undefined;
    onPending: (() => void) | undefined;

    get pendingGopTimes(): number[] { return Array.from(this.pendingGops); }
    private firePending(): void { this.onPending?.(); }

    constructor(
        public canvas: HTMLCanvasElement,
        public api: CameraApi,
        public dayParts: string[],
        public dayStartMs: number,
        public ranges: { start: number; end: number }[],
        public level = 0,
        periodEndMs = 0,
    ) {
        this.comp = Math.pow(30, level);
        this.spanEndMs = periodEndMs || dayStartMs + DAY_MS;
        this.c2d = canvas.getContext("2d");
        this.playWall = dayStartMs;
        this.feedWall = dayStartMs;
        this.fetchWall = dayStartMs;
        this.ctx = {
            state: "idle", intent: "pause", shownWall: -1, pumpGen: 0, fetchToken: 0,
            speed: 1, live: false, gapMode: "blank", loop: null,
            status: "paused", seekingFlag: false, destroyed: false,
        };
        this.rafId = W.requestAnimationFrame ? W.requestAnimationFrame(this.tick) : undefined;
    }

    // ============================ public API ============================
    seekTo(wall: number): void { this.dispatch({ type: "SEEK", wall }); }
    play(): void { this.dispatch({ type: "PLAY" }); }
    pause(): void { this.dispatch({ type: "PAUSE" }); }
    togglePlay(): void { if (this.ctx.intent === "play") this.pause(); else this.play(); }
    setSpeed(s: number): void { this.dispatch({ type: "SET_SPEED", s }); }
    setLoop(start: number, end: number): void { this.dispatch({ type: "SET_LOOP", loop: { start, end } }); }
    clearLoop(): void { this.dispatch({ type: "SET_LOOP", loop: null }); }
    setGapMode(m: GapMode): void { this.dispatch({ type: "SET_GAP", m }); }
    get loop(): { start: number; end: number } | null { return this.ctx.loop; }
    get gapMode(): GapMode { return this.ctx.gapMode; }
    invalidateIndex(): void { this.dispatch({ type: "INVALIDATE_INDEX" }); }
    async startLive(): Promise<void> { this.dispatch({ type: "START_LIVE" }); await this.liveOp; }
    async stopLive(): Promise<void> { this.dispatch({ type: "STOP_LIVE" }); await this.liveOp; }
    teardown(): void { this.dispatch({ type: "TEARDOWN" }); }
    nudge(deltaMs: number): void { this.seekTo(this.playWall + deltaMs); }
    seekTarget(): number { return this.playWall; }
    currentWall(): number { return this.playWall; }

    get playStatus(): PlayStatus { return this.ctx.status; }
    get wantsPlay(): boolean { return this.ctx.intent === "play"; }
    get compression(): number { return this.comp; }
    get isLive(): boolean { return this.ctx.live; }

    // ============================ state machine ============================
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

    private applyEvent(ev: FsmEvent): void {
        const c = this.ctx;
        switch (ev.type) {
            case "SEEK":
                if (c.live) return;
                this.playWall = Math.max(this.dayStartMs, Math.min(this.spanEndMs - 1, ev.wall));
                c.fetchToken++;
                this.bufferGen++;
                break;
            case "PLAY": if (!c.live) { c.intent = "play"; } break;
            case "PAUSE": if (!c.live) c.intent = "pause"; break;
            case "SET_SPEED": c.speed = ev.s; break;
            case "SET_LOOP": c.loop = ev.loop; break;
            case "SET_GAP": c.gapMode = ev.m; break;
            case "START_LIVE": c.live = true; c.intent = "play"; c.pumpGen++; break;
            case "STOP_LIVE": c.live = false; c.intent = "pause"; c.pumpGen++; c.shownWall = -1; break;
            case "TEARDOWN": c.destroyed = true; c.pumpGen++; break;
            case "FRAME_SHOWN": if (ev.token === c.fetchToken) c.shownWall = ev.wall; break;
            default: break;
        }
    }

    private decide(from: FsmState, ev: FsmEvent): FsmState {
        const c = this.ctx;
        if (c.destroyed) return "destroyed";
        switch (ev.type) {
            case "TEARDOWN": return "destroyed";
            case "START_LIVE": return "live";
            case "STOP_LIVE": return "paused";
            case "SET_SPEED": case "SET_LOOP": case "SET_GAP": return from;
            case "INVALIDATE_INDEX": return from;
        }
        if (c.live || from === "live") return "live";
        switch (ev.type) {
            case "SEEK": return "seeking";
            case "PLAY": return this.hasCurrentFrame() ? "playing" : "seeking";
            case "PAUSE": return "paused";
            case "FRAME_SHOWN":
                if (ev.token !== c.fetchToken) return from;
                return c.intent === "play" ? "playing" : "paused";
            case "UNCOVERED": return "unavailable";
            case "PAUSE_AT_END": return "paused";
            case "FRAME_FETCH_FAILED": return from;
            default: return from;
        }
    }

    private runEffects(from: FsmState, to: FsmState, ev: FsmEvent): void {
        if (ev.type === "SEEK") { try { this.api.cancelStaleGops(); } catch { /* */ } this.action("cancelStale"); this.resetDecodeForSeek(); }
        switch (ev.type) {
            case "TEARDOWN": this.doTeardown(); return;
            case "START_LIVE": this.liveOp = this.doStartLive(); return;
            case "STOP_LIVE": this.liveOp = this.doStopLive(); return;
            case "INVALIDATE_INDEX": this.clearIndexCaches(); this.action("clearIndex"); return;
            case "PAUSE": if (from !== "paused") this.action("pause"); return;
        }
        // The rAF loop drives drawing/pumping for seeking/playing/paused; nothing to do
        // synchronously here beyond kicking the decode pump for responsiveness.
        if (to === "seeking" || to === "playing") void this.decodeAhead();
    }

    private syncOutputs(): void {
        const status = this.statusFor(this.ctx.state);
        if (status !== this.ctx.status) { this.ctx.status = status; this.onStatus?.(status); }
        const seeking = this.ctx.state === "seeking";
        if (seeking !== this.ctx.seekingFlag) { this.ctx.seekingFlag = seeking; this.onSeeking?.(seeking); }
    }

    private statusFor(s: FsmState): PlayStatus {
        switch (s) {
            case "playing": return "playing";
            case "unavailable": return "unavailable";
            case "seeking": return this.ctx.intent === "play" ? "waiting" : "paused";
            case "live": return this.decoded.length ? "playing" : "waiting";
            default: return "paused";
        }
    }

    private action(s: string): void { this.pendingActions.push(s); }
    private logDispatch(ev: FsmEvent, from: FsmState, to: FsmState): void {
        const actions = this.pendingActions; this.pendingActions = [];
        const changed = from !== to;
        const now = Date.now();
        if (!changed && !actions.length) { if (now - this.lastHeartbeat < LOG_HEARTBEAT_MS) return; this.lastHeartbeat = now; }
        pushFsmEntry({ ts: now, ev: ev.type, arg: this.shortArg(ev), from, to, ctx: this.ctxSnapshot(), actions: actions.length ? actions : undefined });
    }
    private shortArg(ev: FsmEvent): string | number | undefined {
        switch (ev.type) {
            case "SEEK": case "FRAME_SHOWN": case "UNCOVERED": return Math.round((ev as any).wall);
            case "SET_SPEED": return (ev as any).s;
            case "SET_GAP": return (ev as any).m;
            default: return undefined;
        }
    }
    private ctxSnapshot(): Record<string, unknown> {
        const c = this.ctx;
        return {
            intent: c.intent, status: c.status, gapMode: c.gapMode,
            playWall: Math.round(this.playWall), shownWall: Math.round(c.shownWall),
            speed: c.speed, level: this.level, comp: this.comp, live: c.live,
            fetchToken: c.fetchToken, decoded: this.decoded.length, ahead: this.aheadFrames(),
            cached: this.bytesCache.size, fed: this.fedGops.size,
            inFlight: this.api.outstandingGops, covered: this.coveredAt(this.playWall),
            footageAhead: this.hasFootageAhead(this.playWall),
            loop: c.loop ? `${Math.round(c.loop.start)}-${Math.round(c.loop.end)}` : null,
        };
    }

    // ============================ rAF render loop ============================
    private tick = (ts: number): void => {
        if (this.ctx.destroyed) return;
        const dt = this.lastTs ? Math.min(250, ts - this.lastTs) : 0;
        this.lastTs = ts;
        try { this.frame(dt); } catch (e) { console.error("[player] frame error", e); }
        this.rafId = W.requestAnimationFrame(this.tick);
    };

    private frame(dtMs: number): void {
        const c = this.ctx;
        if (c.live) {
            if (this.decoded.length) this.playWall = this.decoded[this.decoded.length - 1].wall;
            this.evictLive();
            this.drawCurrent();
            this.emitTime();
            return;
        }
        if (c.state === "playing") {
            // Advance comp*speed real-ms of footage per real-ms of wall-clock (comp = 30^level).
            this.playWall = Math.min(this.spanEndMs - 1, this.playWall + dtMs * this.comp * c.speed);
            this.handleLoopWrap();
            this.handleGapsAndEnd();
        }
        void this.decodeAhead();    // keep a small window decoded ahead of the playhead
        void this.prefetchAhead();  // prefetch GOP bytes ~PRELOAD_PLAYBACK_SEC ahead (× speed)
        this.evictDecoded();
        this.drawCurrent();
        this.emitTime();
    }

    // Emit the playhead only when it actually moved — avoids 60Hz no-op mobx churn while paused.
    private emitTime(): void {
        const w = Math.round(this.playWall);
        if (w === this.lastEmittedWall) return;
        this.lastEmittedWall = w;
        this.onTime?.(this.playWall);
    }

    private handleLoopWrap(): void {
        const lp = this.ctx.loop;
        if (lp && this.ctx.state === "playing" && this.playWall >= lp.end) this.seekTo(lp.start);
    }

    // While playing, if the playhead is over a gap (or past the end), act per gapMode.
    private handleGapsAndEnd(): void {
        if (this.ctx.state !== "playing") return;
        if (this.coveredAt(this.playWall)) return;
        const next = this.nextRangeStart(this.playWall);
        if (this.ctx.gapMode === "skip") {
            if (next != null) { this.action(`skipGap->${Math.round(next)}`); this.playWall = next; }
            else this.dispatch({ type: "PAUSE_AT_END" });
            return;
        }
        // blank: keep advancing (drawCurrent paints the missing-video card); pause only at the true end.
        if (next == null && !this.hasFootageAhead(this.playWall)) this.dispatch({ type: "PAUSE_AT_END" });
    }

    // ============================ drawing ============================
    private bestFrameAt(wall: number): { wall: number; frame: any } | undefined {
        let best: { wall: number; frame: any } | undefined;
        for (const d of this.decoded) { if (d.wall <= wall) best = d; else break; }
        return best;
    }

    private drawCurrent(): void {
        const c = this.ctx;
        // Over a gap (review): paint the missing-video card with a live-updating timestamp.
        // Shown for both gap modes when not covered — "skip" only actively jumps the playhead
        // while PLAYING (handleGapsAndEnd); a paused/seeking landing in a gap still shows this.
        if (!c.live && !this.coveredAt(this.playWall) && this.ranges.length) {
            this.drawBlank(this.playWall);
            if (c.state === "seeking") this.dispatch({ type: "FRAME_SHOWN", wall: this.playWall, token: c.fetchToken });
            return;
        }
        const best = this.bestFrameAt(this.playWall);
        if (best) {
            this.drawFrame(best.frame);
            if (c.state === "seeking") this.dispatch({ type: "FRAME_SHOWN", wall: this.playWall, token: c.fetchToken });
        }
        // else: target frame not decoded yet — keep the previous canvas contents.
    }

    private drawFrame(frame: any): void {
        if (!this.c2d) return;
        if (!this.canvasSized && frame.displayWidth) { this.canvas.width = frame.displayWidth; this.canvas.height = frame.displayHeight; this.canvasSized = true; }
        try { this.c2d.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height); } catch { /* frame closed */ }
    }

    private drawBlank(wall: number): void {
        if (!this.c2d) return;
        if (!this.canvasSized) { this.canvas.width = 1280; this.canvas.height = 720; this.canvasSized = true; }
        const ctx = this.c2d, w = this.canvas.width, h = this.canvas.height;
        ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, w, h);
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.font = `${Math.round(h * 0.05)}px sans-serif`;
        ctx.fillText("No video at", w / 2, h / 2 - h * 0.06);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = `${Math.round(h * 0.08)}px monospace`;
        ctx.fillText(clockHMS(wall), w / 2, h / 2 + h * 0.04);
    }

    // ============================ decode pump ============================
    private hasCurrentFrame(): boolean {
        // Over a gap we can always settle immediately (blank card / skip handles it).
        if (!this.coveredAt(this.playWall)) return this.ranges.length > 0;
        return !!this.bestFrameAt(this.playWall);
    }

    private aheadFrames(): number {
        let n = 0;
        for (const d of this.decoded) if (d.wall > this.playWall) n++;
        return n;
    }

    private ensureDecoder(codec: string): void {
        if (typeof W.VideoDecoder !== "function") return;
        if (this.decoder && this.decoderCodec === codec) return;
        if (this.decoder) { try { this.decoder.close(); } catch { /* */ } }
        this.decoderCodec = codec;
        this.decodeConfigured = false;
        this.decoder = new W.VideoDecoder({
            output: (frame: any) => this.onDecoded(frame),
            error: (e: any) => { console.warn("[player] decoder error", e?.message || e); this.decodeConfigured = false; },
        });
    }

    private onDecoded(frame: any): void {
        if (this.ctx.destroyed) { try { frame.close(); } catch { /* */ } return; }
        const wall = frame.timestamp / 1000;
        // insert sorted (streams are in order, so this is almost always a push)
        if (!this.decoded.length || wall >= this.decoded[this.decoded.length - 1].wall) this.decoded.push({ wall, frame });
        else {
            let i = this.decoded.length;
            while (i > 0 && this.decoded[i - 1].wall > wall) i--;
            this.decoded.splice(i, 0, { wall, frame });
        }
        if (this.decoded.length > DECODE_MAX_FRAMES) { const d = this.decoded.shift()!; try { d.frame.close(); } catch { /* */ } }
    }

    private resetDecodeForSeek(): void {
        if (this.decoder) { try { this.decoder.reset(); } catch { /* */ } }
        this.decodeConfigured = false;
        this.closeDecoded();
        this.fedGops.clear();
        this.bytesCache.clear();
        this.feedWall = this.playWall;
        this.fetchWall = this.playWall;
    }

    // Per-frame wall times inside a GOP, spreading n frames over its real span.
    private frameWalls(g: GopEntry, n: number): number[] {
        const nominal = (g.n / FPS) * 1000 * this.comp;       // expected real span of the GOP
        const next = this.nextStartWallSync(g);
        let span = next != null ? next - g.t : nominal;
        if (!(span > 0) || span > nominal * 2) span = nominal;  // gap after this GOP -> don't stretch
        const step = span / Math.max(1, n);
        const out: number[] = [];
        for (let i = 0; i < n; i++) out.push(g.t + i * step);
        return out;
    }

    // Decode one GOP's bytes into the decoder (no fetching — bytes are supplied).
    private feedDecoder(g: GopEntry, data: Buffer): boolean {
        if (this.ctx.destroyed || this.ctx.live) return false;
        const { nals, units } = accessUnitsFromGop(data);
        if (!units.length) return false;
        this.ensureDecoder(codecFromSps(nals));
        if (!this.decoder) return false;
        if (!this.decodeConfigured) { try { this.decoder.configure({ codec: this.decoderCodec, optimizeForLatency: true }); this.decodeConfigured = true; } catch (e) { console.warn("[player] configure failed", e); return false; } }
        const walls = this.frameWalls(g, units.length);
        for (let i = 0; i < units.length; i++) {
            try { this.decoder.decode(new W.EncodedVideoChunk({ type: units[i].key ? "key" : "delta", timestamp: Math.round(walls[i] * 1000), data: units[i].data })); }
            catch (e) { console.warn("[player] decode failed", e); return false; }
        }
        return true;
    }

    // DECODE pump: keep only a small window decoded ahead of the playhead (memory-bounded
    // by DECODE_AHEAD_FRAMES / DECODE_MAX_FRAMES). Bytes come from the prefetch cache when
    // available; the seek/play target is fetched with priority on a miss. Subordinate to
    // seeks via bufferGen.
    private async decodeAhead(): Promise<void> {
        if (this.decoding || this.ctx.live || this.ctx.destroyed) return;
        this.decoding = true;
        const gen = this.bufferGen;
        try {
            let guard = 0;
            while (gen === this.bufferGen && !this.ctx.destroyed && !this.ctx.live
                && this.decoded.length < DECODE_MAX_FRAMES && this.aheadFrames() < DECODE_AHEAD_FRAMES) {
                if (++guard > 64) break;
                const isFirst = this.decoded.length === 0;
                // First fill after a seek: the GOP at the playhead (or, if the playhead is in
                // a gap, the next GOP ahead). Look-ahead: the GOP after the last fed.
                const g = isFirst
                    ? (this.coveredAt(this.playWall) ? await this.gopAt2(this.playWall) : (await this.gopsAhead(this.playWall, 1))[0])
                    : (await this.gopsAhead(this.feedWall, 1))[0];
                if (!g) break;                         // nothing here/ahead (gap-end or footage-end)
                if (this.fedGops.has(g.g.t)) { this.feedWall = g.g.t + this.gopDurMs(g.g) + 1; continue; }
                let data = this.bytesCache.get(g.g.t);
                if (data) this.bytesCache.delete(g.g.t);
                else data = await this.fetchGopData(g.g, isFirst);  // miss -> fetch (priority for the target)
                if (gen !== this.bufferGen || this.ctx.destroyed || this.ctx.live) break;
                this.fedGops.add(g.g.t);
                if (!this.feedDecoder(g.g, data)) { this.fedGops.delete(g.g.t); break; }
                this.recordFetched(g.g);
                this.feedWall = g.g.t + this.gopDurMs(g.g) + 1;
                if (isFirst && this.decoder) { try { await this.decoder.flush(); } catch { /* */ } } // surface the target promptly
            }
        } finally { this.decoding = false; }
    }

    // PREFETCH pump: fetch GOP *bytes* ahead of the playhead up to PRELOAD_PLAYBACK_SEC of
    // playback (scaled by speed: faster playback drains faster, so look further). Bytes are
    // cached for the decode pump to consume — this bounds network preloading to ~10s of
    // upcoming content instead of racing arbitrarily far ahead.
    private async prefetchAhead(): Promise<void> {
        if (this.prefetching || this.ctx.live || this.ctx.destroyed) return;
        this.prefetching = true;
        const gen = this.bufferGen;
        try {
            const horizon = PRELOAD_PLAYBACK_SEC * 1000 * this.comp * Math.max(1, this.ctx.speed);
            let guard = 0;
            while (gen === this.bufferGen && !this.ctx.destroyed && !this.ctx.live && this.fetchWall < this.playWall + horizon) {
                if (++guard > 256) break;
                const g = (await this.gopsAhead(this.fetchWall, 1))[0];
                if (!g) break;
                this.fetchWall = g.g.t + this.gopDurMs(g.g) + 1;
                const t = g.g.t;
                if (this.bytesCache.has(t) || this.fedGops.has(t) || this.pendingGops.has(t)) continue;
                if (gen !== this.bufferGen) break;
                try {
                    const data = await this.fetchGopData(g.g, false); // cancellable background prefetch
                    if (gen === this.bufferGen && !this.ctx.destroyed && !this.ctx.live) { this.bytesCache.set(t, data); this.recordFetched(g.g); this.trimCaches(); }
                } catch { /* cancelled / failed — decode pump will refetch on demand */ }
            }
        } finally { this.prefetching = false; }
    }

    // Bound the prefetch byte cache and the fed-GOP set (drop entries well behind the playhead).
    private trimCaches(): void {
        const behind = this.playWall - this.comp * 1000;
        for (const t of Array.from(this.bytesCache.keys())) if (t < behind) this.bytesCache.delete(t);
        while (this.bytesCache.size > BYTES_CACHE_MAX) { const k = this.bytesCache.keys().next().value as number; this.bytesCache.delete(k); }
        if (this.fedGops.size > 600) { for (const t of Array.from(this.fedGops)) if (t < behind) this.fedGops.delete(t); }
    }

    // ============================ index / fetch (unchanged plumbing) ============================
    private hourNumOf(wall: number): number { return Math.floor((wall - this.dayStartMs) / 3600_000); }
    private gopDurMs(g: GopEntry): number { return this.level > 0 ? Math.max(1, g.e - g.t) : Math.round((g.n / FPS) * 1000); }
    private coveredAt(wall: number): boolean { return this.ranges.some(r => wall >= r.start && wall <= r.end + 500); }
    private hasFootageAhead(wall: number): boolean { return this.ranges.some(r => r.end > wall + 1000); }
    private nextRangeStart(wall: number): number | null {
        let best: number | null = null;
        for (const r of this.ranges) if (r.start > wall && (best == null || r.start < best)) best = r.start;
        return best;
    }
    private clearIndexCaches(): void { this.hourCache.clear(); this.levelReady = undefined; this.levelGops = []; }

    private ensureLevelLoaded(): Promise<void> {
        if (!this.levelReady) this.levelReady = (async () => {
            try { const r = await this.api.getLevelIndex(this.level, this.dayStartMs, this.spanEndMs); this.levelGops = ((r && r.gops) || []).slice().sort((a, b) => a.t - b.t); }
            catch { this.levelGops = []; }
        })();
        return this.levelReady;
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

    // GOP at-or-before `wall` (level-aware), as { hh, g } — the GOP whose IDR we feed.
    private async gopAt2(wall: number): Promise<{ hh: string; g: GopEntry } | undefined> {
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

    private async gopsAhead(fromWall: number, count: number): Promise<{ hh: string; g: GopEntry }[]> {
        const out: { hh: string; g: GopEntry }[] = [];
        if (this.level > 0) {
            await this.ensureLevelLoaded();
            for (const g of this.levelGops) { if (g.t + this.gopDurMs(g) < fromWall) continue; out.push({ hh: "", g }); if (out.length >= count) break; }
            return out;
        }
        for (let hn = this.hourNumOf(fromWall); hn <= 23 && out.length < count; hn++) {
            const hh = pad2(hn);
            for (const g of await this.ensureHour(hn)) { if (g.t + this.gopDurMs(g) < fromWall) continue; out.push({ hh, g }); if (out.length >= count) break; }
        }
        return out;
    }

    private nextStartWallSync(g: GopEntry): number | null {
        if (this.level > 0) { for (const x of this.levelGops) if (x.t > g.t) return x.t; return null; }
        const hn = this.hourNumOf(g.t);
        for (let h = hn; h <= 23; h++) { const gops = this.hourCache.get(pad2(h)); if (!gops) continue; for (const x of gops) if (x.t > g.t) return x.t; }
        return null;
    }

    private async fetchGopData(g: GopEntry, priority: boolean): Promise<Buffer> {
        const opt = { cancellable: !priority };
        this.pendingGops.add(g.t); this.firePending();
        try {
            const data = this.level > 0
                ? await this.api.getLevelGopData(this.level, g.t, g.f, g.o, g.l, opt)
                : await this.api.getGopData(this.dayParts, g.f, g.o, g.l, opt);
            return Buffer.from(data);
        } finally { this.pendingGops.delete(g.t); this.firePending(); }
    }

    private recordFetched(g: GopEntry): void {
        this.fetched.set(g.t, { start: g.t, end: g.t + this.gopDurMs(g) });
        this.firePending();
    }

    // Merged wall-clock spans of GOPs we've fetched/decoded (drives the green loaded band).
    bufferedWallRanges(): { start: number; end: number }[] {
        const items = Array.from(this.fetched.values()).sort((a, b) => a.start - b.start);
        const out: { start: number; end: number }[] = [];
        for (const it of items) {
            const last = out[out.length - 1];
            if (last && it.start <= last.end + 1) last.end = Math.max(last.end, it.end);
            else out.push({ start: it.start, end: it.end });
        }
        return out;
    }

    // ============================ frame memory management ============================
    private evictDecoded(): void {
        // Keep the current best (<=playWall) plus everything ahead; drop older ones.
        while (this.decoded.length >= 2 && this.decoded[1].wall <= this.playWall) {
            const d = this.decoded.shift()!; try { d.frame.close(); } catch { /* */ }
        }
    }
    private evictLive(): void {
        while (this.decoded.length > LIVE_KEEP_FRAMES) { const d = this.decoded.shift()!; try { d.frame.close(); } catch { /* */ } }
    }
    private closeDecoded(): void { for (const d of this.decoded) { try { d.frame.close(); } catch { /* */ } } this.decoded = []; }

    // ============================ live ============================
    private async doStartLive(): Promise<void> {
        this.disposeDecoder();
        this.fetched.clear(); this.pendingGops.clear(); this.firePending();
        this.liveChain = Promise.resolve();
        try { await this.api.startStream(this.dayParts.join("/"), (meta, bytes) => void this.onLiveData(meta, bytes)); }
        catch (e) { this.ctx.live = false; this.ctx.state = "paused"; this.syncOutputs(); throw e; }
    }

    private async doStopLive(): Promise<void> {
        try { await this.api.stopStream(); } catch { /* */ }
        this.disposeDecoder();
    }

    private onLiveData(meta: { t: number; e: number; n: number }, bytes: Uint8Array): void {
        if (!this.ctx.live) return;
        this.liveChain = this.liveChain.then(() => this.feedLive(meta, bytes)).catch(() => { /* */ });
    }
    private async feedLive(meta: { t: number; e: number; n: number }, bytes: Uint8Array): Promise<void> {
        if (!this.ctx.live) return;
        const { nals, units } = accessUnitsFromGop(Buffer.from(bytes));
        if (!units.length) return;
        this.ensureDecoder(codecFromSps(nals));
        if (!this.decoder) return;
        if (!this.decodeConfigured) { try { this.decoder.configure({ codec: this.decoderCodec, optimizeForLatency: true }); this.decodeConfigured = true; } catch { return; } }
        const span = meta.n > 0 ? (meta.e - meta.t) / meta.n : 1000 / FPS;
        for (let i = 0; i < units.length; i++) {
            const wall = meta.t + i * (span > 0 ? span : 1000 / FPS);
            try { this.decoder.decode(new W.EncodedVideoChunk({ type: units[i].key ? "key" : "delta", timestamp: Math.round(wall * 1000), data: units[i].data })); }
            catch { return; }
        }
    }

    // ============================ teardown ============================
    private disposeDecoder(): void {
        if (this.decoder) { try { this.decoder.close(); } catch { /* */ } this.decoder = undefined; }
        this.decoderCodec = ""; this.decodeConfigured = false;
        this.closeDecoded(); this.fedGops.clear(); this.bytesCache.clear();
    }
    private doTeardown(): void {
        if (this.rafId != null && W.cancelAnimationFrame) { try { W.cancelAnimationFrame(this.rafId); } catch { /* */ } }
        this.rafId = undefined;
        try { void this.api.stopStream(); } catch { /* */ }
        this.disposeDecoder();
        this.fetched.clear(); this.pendingGops.clear(); this.hourCache.clear();
    }
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }
