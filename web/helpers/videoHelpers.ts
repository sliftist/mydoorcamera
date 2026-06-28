// Day player — a simple, self-driven renderer. We decode H.264 ourselves with
// WebCodecs VideoDecoder and paint frames onto a <canvas> on a requestAnimationFrame
// loop. WE own the playhead (`playWall`, wall-clock ms), so there is no MediaSource,
// no <video> element, and no FSM coordinating with the browser's playback engine.
//
// The whole thing is one loop (step()) plus two bounded pumps:
//   - decode pump  : keep ~DECODE_AHEAD_SEC of playback DECODED ahead of the playhead
//                    (bounded by feedWall, advanced synchronously as GOPs are queued).
//   - prefetch pump: fetch GOP *bytes* ~PRELOAD_PLAYBACK_SEC ahead (bounded by fetchWall).
// Each step advances the playhead (only while playing), tops up the pumps, evicts old
// frames, and draws the frame at the playhead. Because we only ever draw frames we
// actually have and advance by real time, playback can't stall: at the footage edge we
// pause; over a gap we show a "no video" card or skip; and if decoding can't keep up we
// drop (skip) frames and flag it (red outline) instead of lagging behind real time.

import { CameraApi, GopEntry } from "./api";
import { accessUnitsFromGop, codecFromSps } from "./h264";
import { FPS } from "../../src/config";
import { clockHMS, pad2 } from "./format";
import { pushFsmEntry } from "./playerLog";

export type PlayStatus = "playing" | "paused" | "waiting" | "unavailable";
export type GapMode = "blank" | "skip";

const DAY_MS = 24 * 3600 * 1000;
const DECODE_AHEAD_SEC = 2;        // keep ~this many playback-seconds DECODED ahead (× speed)
const DECODE_MAX_FRAMES = 120;     // hard cap on decoded VideoFrames held (memory safety)
const PRELOAD_PLAYBACK_SEC = 10;   // prefetch GOP *bytes* this many playback-seconds ahead (× speed)
const BYTES_CACHE_MAX = 64;        // hard cap on prefetched GOP byte buffers held
const LIVE_KEEP_FRAMES = 3;        // live: keep only the newest few decoded frames
const BEHIND_FRAMES = 3;           // "can't keep up" once the shown frame is this many frame-intervals behind
const DROP_HYSTERESIS_MS = 400;    // keep the red flag this long after the last behind tick (anti-flicker)
const RESYNC_AHEAD_MULT = 2;       // if behind by > this × the decode window, drop the stale backlog and resync
const WARN_THROTTLE_MS = 1000;
const W: any = typeof window !== "undefined" ? window : {};

type Decoded = { wall: number; frame: any }; // frame: VideoFrame

export class DayPlayer {
    private c2d: CanvasRenderingContext2D | null;
    private canvasSized = false;

    // playback state (plain — no FSM)
    private playing = false;
    private live = false;
    private gapModeVal: GapMode = "blank";
    private speed = 1;
    private loopVal: { start: number; end: number } | null = null;
    private destroyed = false;
    private playWall: number;
    private shownWall = -1;          // wall of the frame currently on the canvas
    private seekPending = false;     // playhead jumped (seek); target frame not drawn yet -> yellow

    // decode pipeline
    private comp = 1;                // 30^level: real-seconds advanced per playback-second
    private decoder: any | undefined;
    private decoderCodec = "";
    private decodeConfigured = false;
    private decoded: Decoded[] = []; // sorted ascending by wall
    private feedWall: number;        // wall up to which the decode pump has queued GOPs
    private fetchWall: number;       // wall up to which the prefetch pump has fetched bytes
    private fedGops = new Set<number>();
    private bytesCache = new Map<number, Buffer>();
    private decoding = false;
    private prefetching = false;
    private seekGen = 0;             // bumped on seek/skip to abandon stale fetch+decode work

    // index / coverage
    private hourCache = new Map<string, GopEntry[]>();
    private levelGops: GopEntry[] = [];
    private levelReady: Promise<void> | undefined;
    private spanEndMs = 0;

    // markers
    private pendingGops = new Set<number>();
    private fetched = new Map<number, { start: number; end: number }>();

    // behind / drop tracking
    private lastBehindTs = 0;
    private wasBehind = false;
    private lastWarnTs = 0;
    private lastResyncTs = 0;
    private droppingFlag = false;

    // emitted-value de-dup
    private lastEmittedWall = -1;
    private lastStatus: PlayStatus = "paused";
    private lastSeeking = false;
    private lastDropping = false;

    private liveChain: Promise<void> = Promise.resolve();
    private liveOp: Promise<void> = Promise.resolve();
    private rafId: number | undefined;
    private lastTs = 0;

    onTime: ((wallMs: number) => void) | undefined;
    onStatus: ((s: PlayStatus) => void) | undefined;
    onSeeking: ((seeking: boolean) => void) | undefined;   // yellow: loading a seek target
    onDropping: ((dropping: boolean) => void) | undefined; // red: playing but can't keep up
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
        this.rafId = W.requestAnimationFrame ? W.requestAnimationFrame(this.tick) : undefined;
    }

    // ============================ public API ============================
    seekTo(wall: number): void {
        if (this.live || this.destroyed) return;
        this.playWall = this.clampWall(wall);
        this.seekPending = true;
        this.beginSeek();
        this.log("SEEK", Math.round(this.playWall));
    }
    play(): void { if (!this.live && !this.destroyed && !this.playing) { this.playing = true; this.log("PLAY"); } }
    pause(): void { if (!this.live && this.playing) { this.playing = false; this.log("PAUSE"); } }
    togglePlay(): void { if (this.playing) this.pause(); else this.play(); }
    setSpeed(s: number): void { this.speed = s > 0 ? s : 1; }
    setLoop(start: number, end: number): void { this.loopVal = { start, end }; }
    clearLoop(): void { this.loopVal = null; }
    setGapMode(m: GapMode): void { this.gapModeVal = m; }
    invalidateIndex(): void { this.clearIndexCaches(); }
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

    // ============================ the loop ============================
    private tick = (ts: number): void => {
        if (this.destroyed) return;
        const dt = this.lastTs ? Math.min(250, ts - this.lastTs) : 0; // cap (tab was backgrounded)
        this.lastTs = ts;
        try { this.step(dt); } catch (e) { console.error("[player] step error", e); }
        this.rafId = W.requestAnimationFrame(this.tick);
    };

    private step(dtMs: number): void {
        if (this.live) { this.stepLive(); return; }

        if (this.playing) {
            this.playWall = this.clampWall(this.playWall + dtMs * this.comp * this.speed);
            this.applyLoopAndGaps();
        }
        void this.pumpDecode();
        void this.pumpPrefetch();
        this.evict();
        this.render();
        this.updateBehind();
        this.emit();
    }

    private clampWall(w: number): number { return Math.max(this.dayStartMs, Math.min(this.spanEndMs - 1, w)); }

    // Lightweight event log -> the ⤓ debug download (scalars only). Not an FSM; just a trace.
    private log(ev: string, arg?: string | number): void {
        try {
            pushFsmEntry({
                ts: Date.now(), ev, arg, from: this.lastStatus, to: this.statusNow(),
                ctx: {
                    playing: this.playing, live: this.live, status: this.lastStatus,
                    playWall: Math.round(this.playWall), shownWall: Math.round(this.shownWall),
                    speed: this.speed, level: this.level, comp: this.comp,
                    decoded: this.decoded.length, cached: this.bytesCache.size, fed: this.fedGops.size,
                    feedAhead: Math.round((this.feedWall - this.playWall) / this.comp),
                    fetchAhead: Math.round((this.fetchWall - this.playWall) / this.comp),
                    inFlight: this.api.outstandingGops, covered: this.coveredAt(this.playWall),
                    seekPending: this.seekPending, dropping: this.droppingFlag,
                    loop: this.loopVal ? `${Math.round(this.loopVal.start)}-${Math.round(this.loopVal.end)}` : null,
                },
            });
        } catch { /* */ }
    }

    // Loop wrap, gap crossing, and natural end-of-footage pause (only while playing).
    private applyLoopAndGaps(): void {
        const lp = this.loopVal;
        if (lp && this.playWall >= lp.end) { this.seekTo(lp.start); return; }
        if (this.coveredAt(this.playWall)) return;
        const next = this.nextRangeStart(this.playWall);
        if (this.gapModeVal === "skip") {
            if (next != null) { this.log("SKIPGAP", Math.round(next)); this.seekTo(next); } // jump over the gap
            else { this.playing = false; this.log("END"); }                                  // nothing ahead -> stop
        } else { // blank: keep advancing through the gap (render paints the card); stop only at the true end
            if (next == null && !this.hasFootageAhead(this.playWall)) { this.playing = false; this.log("END"); }
        }
    }

    // ============================ drawing ============================
    private bestFrameAt(wall: number): Decoded | undefined {
        let best: Decoded | undefined;
        for (const d of this.decoded) { if (d.wall <= wall) best = d; else break; }
        return best;
    }
    private inGap(): boolean { return !this.coveredAt(this.playWall) && this.ranges.length > 0; }

    private render(): void {
        if (this.inGap()) { this.drawBlank(this.playWall); this.shownWall = this.playWall; return; }
        const best = this.bestFrameAt(this.playWall);
        if (best) { this.drawFrame(best.frame); this.shownWall = best.wall; }
        // else: target frame not decoded yet — keep whatever's on the canvas.
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
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font = `${Math.round(h * 0.05)}px sans-serif`;
        ctx.fillText("No video at", w / 2, h / 2 - h * 0.06);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = `${Math.round(h * 0.08)}px monospace`;
        ctx.fillText(clockHMS(wall), w / 2, h / 2 + h * 0.04);
    }

    // ============================ behind / dropping ============================
    private frameIntervalMs(): number { return (this.comp * 1000) / FPS; }

    private updateBehind(): void {
        const now = Date.now();
        const best = this.bestFrameAt(this.playWall);
        const inGap = this.inGap();
        const tol = BEHIND_FRAMES * this.frameIntervalMs();
        const haveTarget = inGap || (!!best && (this.playWall - best.wall) <= tol);
        if (haveTarget) this.seekPending = false; // the seek/jump target is now on screen

        // "behind" = we're playing past a settled seek, the area is covered, but we can't
        // show a current frame (decoder can't keep up). NOT the same as a fresh seek (yellow).
        const behind = this.playing && !this.live && !this.seekPending && !inGap && this.coveredAt(this.playWall) && !haveTarget;
        if (behind) {
            this.lastBehindTs = now;
            if (!this.wasBehind || now - this.lastWarnTs >= WARN_THROTTLE_MS) {
                const behindMs = best ? Math.round((this.playWall - best.wall) / this.comp) : -1;
                console.warn(`[player] dropping frames — can't keep up (behind ${behindMs >= 0 ? behindMs + "ms playback" : "starved"}, decoded=${this.decoded.length})`);
                this.lastWarnTs = now;
            }
            if (!this.wasBehind) this.log("BEHIND", best ? Math.round((this.playWall - best.wall) / this.comp) : -1);
            // Far behind: the decoder backlog is stale. Drop it and resync to the playhead.
            const window = DECODE_AHEAD_SEC * 1000 * this.comp;
            if (best && (this.playWall - best.wall) > RESYNC_AHEAD_MULT * window && now - this.lastResyncTs > 500) {
                this.lastResyncTs = now;
                console.warn("[player] resync: dropping stale decode backlog");
                this.log("RESYNC");
                this.beginSeek(); // reset decoder + caches at the current playWall
            }
        }
        this.wasBehind = behind;
        this.droppingFlag = this.playing && (now - this.lastBehindTs) < DROP_HYSTERESIS_MS;
    }

    // ============================ emit derived signals ============================
    private statusNow(): PlayStatus {
        if (this.live) return this.decoded.length ? "playing" : "waiting";
        if (!this.ranges.length) return "unavailable";
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
        if (this.droppingFlag !== this.lastDropping) { this.lastDropping = this.droppingFlag; this.onDropping?.(this.droppingFlag); }
    }

    // ============================ decode ============================
    private beginSeek(): void {
        this.seekGen++;
        try { this.api.cancelStaleGops(); } catch { /* */ }
        if (this.decoder) { try { this.decoder.reset(); } catch { /* */ } }
        this.decodeConfigured = false;
        this.closeDecoded();
        this.fedGops.clear();
        this.bytesCache.clear();
        this.feedWall = this.playWall;
        this.fetchWall = this.playWall;
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
        if (this.destroyed) { try { frame.close(); } catch { /* */ } return; }
        const wall = frame.timestamp / 1000;
        if (!this.decoded.length || wall >= this.decoded[this.decoded.length - 1].wall) this.decoded.push({ wall, frame });
        else { let i = this.decoded.length; while (i > 0 && this.decoded[i - 1].wall > wall) i--; this.decoded.splice(i, 0, { wall, frame }); }
        if (this.decoded.length > DECODE_MAX_FRAMES) { const d = this.decoded.shift()!; try { d.frame.close(); } catch { /* */ } }
    }

    // Per-frame wall times inside a GOP, spread over its real span (don't stretch over a gap).
    private frameWalls(g: GopEntry, n: number): number[] {
        const nominal = (g.n / FPS) * 1000 * this.comp;
        const next = this.nextStartWallSync(g);
        let span = next != null ? next - g.t : nominal;
        if (!(span > 0) || span > nominal * 2) span = nominal;
        const step = span / Math.max(1, n);
        const out: number[] = [];
        for (let i = 0; i < n; i++) out.push(g.t + i * step);
        return out;
    }

    private feedDecoder(g: GopEntry, data: Buffer): boolean {
        if (this.destroyed || this.live) return false;
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

    // DECODE pump: keep a small window decoded ahead of the playhead. Bounded by how far
    // we've FED (feedWall, synchronous) — never by the decoder's async output, which lags.
    private async pumpDecode(): Promise<void> {
        if (this.decoding || this.live || this.destroyed) return;
        this.decoding = true;
        const gen = this.seekGen;
        const horizon = DECODE_AHEAD_SEC * 1000 * this.comp * Math.max(1, this.speed);
        try {
            let guard = 0;
            while (gen === this.seekGen && !this.destroyed && !this.live
                && this.decoded.length < DECODE_MAX_FRAMES
                && (this.decoded.length === 0 || this.feedWall < this.playWall + horizon)) {
                if (++guard > 32) break;
                const first = this.decoded.length === 0;
                const sel = first
                    ? (this.coveredAt(this.playWall) ? await this.gopAt(this.playWall) : (await this.gopsAhead(this.playWall, 1))[0])
                    : (await this.gopsAhead(this.feedWall, 1))[0];
                if (!sel) break;
                const g = sel.g;
                if (this.fedGops.has(g.t)) { this.feedWall = g.t + this.gopDurMs(g) + 1; continue; }
                let data = this.bytesCache.get(g.t);
                if (data) this.bytesCache.delete(g.t);
                else data = await this.fetchGopData(g, first); // miss -> fetch (priority for the target)
                if (gen !== this.seekGen || this.destroyed || this.live) break;
                this.fedGops.add(g.t);
                if (!this.feedDecoder(g, data)) { this.fedGops.delete(g.t); break; }
                this.recordFetched(g);
                this.feedWall = g.t + this.gopDurMs(g) + 1;
                if (first && this.decoder) { try { await this.decoder.flush(); } catch { /* */ } } // surface the target promptly
            }
        } finally { this.decoding = false; }
    }

    // PREFETCH pump: fetch GOP *bytes* ~PRELOAD_PLAYBACK_SEC of playback ahead (× speed),
    // cached for the decode pump. Bounds network preloading instead of racing arbitrarily far.
    private async pumpPrefetch(): Promise<void> {
        if (this.prefetching || this.live || this.destroyed) return;
        this.prefetching = true;
        const gen = this.seekGen;
        const horizon = PRELOAD_PLAYBACK_SEC * 1000 * this.comp * Math.max(1, this.speed);
        try {
            let guard = 0;
            while (gen === this.seekGen && !this.destroyed && !this.live && this.fetchWall < this.playWall + horizon) {
                if (++guard > 64) break;
                const sel = (await this.gopsAhead(this.fetchWall, 1))[0];
                if (!sel) break;
                const g = sel.g;
                this.fetchWall = g.t + this.gopDurMs(g) + 1;
                if (this.bytesCache.has(g.t) || this.fedGops.has(g.t) || this.pendingGops.has(g.t)) continue;
                if (gen !== this.seekGen) break;
                try {
                    const data = await this.fetchGopData(g, false); // cancellable background prefetch
                    if (gen === this.seekGen && !this.destroyed && !this.live) { this.bytesCache.set(g.t, data); this.recordFetched(g); this.trimCaches(); }
                } catch { /* cancelled / failed — decode pump refetches on demand */ }
            }
        } finally { this.prefetching = false; }
    }

    private trimCaches(): void {
        const behind = this.playWall - this.comp * 1000;
        for (const t of Array.from(this.bytesCache.keys())) if (t < behind) this.bytesCache.delete(t);
        while (this.bytesCache.size > BYTES_CACHE_MAX) { const k = this.bytesCache.keys().next().value as number; this.bytesCache.delete(k); }
        if (this.fedGops.size > 600) for (const t of Array.from(this.fedGops)) if (t < behind) this.fedGops.delete(t);
    }

    private evict(): void {
        while (this.decoded.length >= 2 && this.decoded[1].wall <= this.playWall) { const d = this.decoded.shift()!; try { d.frame.close(); } catch { /* */ } }
    }
    private closeDecoded(): void { for (const d of this.decoded) { try { d.frame.close(); } catch { /* */ } } this.decoded = []; }

    // ============================ index / fetch ============================
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

    private async gopAt(wall: number): Promise<{ g: GopEntry } | undefined> {
        if (this.level > 0) {
            await this.ensureLevelLoaded();
            let found: GopEntry | undefined;
            for (const g of this.levelGops) { if (g.t <= wall) found = g; else break; }
            if (!found && this.levelGops.length) found = this.levelGops[0];
            return found ? { g: found } : undefined;
        }
        const base = this.hourNumOf(wall);
        for (let hn = base; hn >= Math.max(0, base - 3); hn--) {
            const gops = await this.ensureHour(hn);
            let found: GopEntry | undefined;
            for (const g of gops) { if (g.t <= wall) found = g; else break; }
            if (found) return { g: found };
        }
        for (let hn = base; hn <= Math.min(23, base + 3); hn++) {
            const gops = await this.ensureHour(hn);
            if (gops.length) return { g: gops[0] };
        }
        return undefined;
    }

    private async gopsAhead(fromWall: number, count: number): Promise<{ g: GopEntry }[]> {
        const out: { g: GopEntry }[] = [];
        if (this.level > 0) {
            await this.ensureLevelLoaded();
            for (const g of this.levelGops) { if (g.t + this.gopDurMs(g) < fromWall) continue; out.push({ g }); if (out.length >= count) break; }
            return out;
        }
        for (let hn = this.hourNumOf(fromWall); hn <= 23 && out.length < count; hn++) {
            for (const g of await this.ensureHour(hn)) { if (g.t + this.gopDurMs(g) < fromWall) continue; out.push({ g }); if (out.length >= count) break; }
        }
        return out;
    }

    private nextStartWallSync(g: GopEntry): number | null {
        if (this.level > 0) { for (const x of this.levelGops) if (x.t > g.t) return x.t; return null; }
        for (let h = this.hourNumOf(g.t); h <= 23; h++) { const gops = this.hourCache.get(pad2(h)); if (!gops) continue; for (const x of gops) if (x.t > g.t) return x.t; }
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

    private recordFetched(g: GopEntry): void { this.fetched.set(g.t, { start: g.t, end: g.t + this.gopDurMs(g) }); this.firePending(); }

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

    // ============================ live ============================
    private beginLive(): void {
        if (this.live || this.destroyed) return;
        this.live = true; this.playing = true; this.seekPending = false; this.droppingFlag = false;
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
        this.disposeDecoder();
        this.fetched.clear(); this.pendingGops.clear(); this.firePending();
        this.liveChain = Promise.resolve();
        try { await this.api.startStream(this.dayParts.join("/"), (meta, bytes) => void this.onLiveData(meta, bytes)); }
        catch (e) { this.live = false; this.playing = false; throw e; }
    }
    private async doStopLive(): Promise<void> {
        try { await this.api.stopStream(); } catch { /* */ }
        this.disposeDecoder();
    }
    private onLiveData(meta: { t: number; e: number; n: number }, bytes: Uint8Array): void {
        if (!this.live) return;
        this.liveChain = this.liveChain.then(() => this.feedLive(meta, bytes)).catch(() => { /* */ });
    }
    private async feedLive(meta: { t: number; e: number; n: number }, bytes: Uint8Array): Promise<void> {
        if (!this.live) return;
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
    // Live: follow the newest decoded frame, dropping backlog so we stay real-time.
    private stepLive(): void {
        if (this.decoded.length) this.playWall = this.decoded[this.decoded.length - 1].wall;
        while (this.decoded.length > LIVE_KEEP_FRAMES) { const d = this.decoded.shift()!; try { d.frame.close(); } catch { /* */ } }
        const newest = this.decoded[this.decoded.length - 1];
        if (newest) { this.drawFrame(newest.frame); this.shownWall = newest.wall; }
        this.emit();
    }

    // ============================ teardown ============================
    private disposeDecoder(): void {
        if (this.decoder) { try { this.decoder.close(); } catch { /* */ } this.decoder = undefined; }
        this.decoderCodec = ""; this.decodeConfigured = false;
        this.closeDecoded(); this.fedGops.clear(); this.bytesCache.clear();
    }
    private doTeardown(): void {
        this.destroyed = true;
        if (this.rafId != null && W.cancelAnimationFrame) { try { W.cancelAnimationFrame(this.rafId); } catch { /* */ } }
        this.rafId = undefined;
        try { void this.api.stopStream(); } catch { /* */ }
        this.disposeDecoder();
        this.fetched.clear(); this.pendingGops.clear(); this.hourCache.clear();
    }
}
