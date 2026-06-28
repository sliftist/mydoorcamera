// DOWNLOADER + index/geometry authority. Owns the camera API, the per-hour / per-level
// GOP index, the coverage ranges, GOP geometry (durations, per-frame wall times), and a
// raw GOP-bytes cache. Everything that needs "where is the footage" or "give me the bytes
// for this GOP" goes through here. Decoded frames are NOT here — those live in FrameCache.

import { CameraApi, GopEntry } from "../api";
import { FPS } from "../../../src/config";
import { pad2 } from "../format";

const BYTES_CACHE_MAX = 96; // raw GOP byte buffers retained (cheap vs decoded frames)

export class GopSource {
    readonly comp: number;        // 30^level: real seconds per playback second
    readonly frameStep: number;   // footage ms between frames at this level

    private hourCache = new Map<string, GopEntry[]>();
    private levelGops: GopEntry[] = [];
    private levelReady: Promise<void> | undefined;

    private bytesCache = new Map<number, Buffer>();          // gop.t -> bytes
    private inFlightBytes = new Map<number, Promise<Buffer>>();
    private pending = new Set<number>();                      // gop.t with a fetch in flight (yellow markers)
    private fetched = new Map<number, { start: number; end: number }>(); // loaded spans (green band)

    onPending: (() => void) | undefined;

    constructor(
        public api: CameraApi,
        public dayParts: string[],
        public dayStartMs: number,
        public ranges: { start: number; end: number }[],
        public level: number,
        public spanEndMs: number,
    ) {
        this.comp = Math.pow(30, level);
        this.frameStep = (this.comp * 1000) / FPS;
    }

    // ---- coverage ----
    setRanges(r: { start: number; end: number }[]): void { this.ranges = r; }
    coveredAt(wall: number): boolean { return this.ranges.some(r => wall >= r.start && wall <= r.end + 500); }
    hasFootageAhead(wall: number): boolean { return this.ranges.some(r => r.end > wall + 1000); }
    nextRangeStart(wall: number): number | null {
        let best: number | null = null;
        for (const r of this.ranges) if (r.start > wall && (best == null || r.start < best)) best = r.start;
        return best;
    }

    // ---- geometry ----
    private hourNumOf(wall: number): number { return Math.floor((wall - this.dayStartMs) / 3600_000); }
    gopDurMs(g: GopEntry): number { return this.level > 0 ? Math.max(1, g.e - g.t) : Math.round((g.n / FPS) * 1000); }
    // Wall time of the GOP after `g`, if its index is loaded (sync; null if unknown).
    nextStartWall(g: GopEntry): number | null {
        if (this.level > 0) { for (const x of this.levelGops) if (x.t > g.t) return x.t; return null; }
        for (let h = this.hourNumOf(g.t); h <= 23; h++) { const gops = this.hourCache.get(pad2(h)); if (!gops) continue; for (const x of gops) if (x.t > g.t) return x.t; }
        return null;
    }
    // Per-frame wall times inside a GOP, spread over its real span (no stretch over a gap).
    frameWalls(g: GopEntry, n: number): number[] {
        const nominal = (g.n / FPS) * 1000 * this.comp;
        const next = this.nextStartWall(g);
        let span = next != null ? next - g.t : nominal;
        if (!(span > 0) || span > nominal * 2) span = nominal;
        const step = span / Math.max(1, n);
        const out: number[] = [];
        for (let i = 0; i < n; i++) out.push(g.t + i * step);
        return out;
    }

    // ---- index ----
    clearIndex(): void { this.hourCache.clear(); this.levelReady = undefined; this.levelGops = []; }
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

    // The GOP at or before `wall` (the one whose IDR we'd decode for that time).
    async gopForWall(wall: number): Promise<GopEntry | undefined> {
        if (this.level > 0) {
            await this.ensureLevelLoaded();
            let found: GopEntry | undefined;
            for (const g of this.levelGops) { if (g.t <= wall) found = g; else break; }
            if (!found && this.levelGops.length) found = this.levelGops[0];
            return found;
        }
        const base = this.hourNumOf(wall);
        for (let hn = base; hn >= Math.max(0, base - 3); hn--) {
            const gops = await this.ensureHour(hn);
            let found: GopEntry | undefined;
            for (const g of gops) { if (g.t <= wall) found = g; else break; }
            if (found) return found;
        }
        for (let hn = base; hn <= Math.min(23, base + 3); hn++) {
            const gops = await this.ensureHour(hn);
            if (gops.length) return gops[0];
        }
        return undefined;
    }

    // Up to `count` GOPs whose span reaches `fromWall` or later (covering or ahead).
    async gopsFrom(fromWall: number, count: number): Promise<GopEntry[]> {
        const out: GopEntry[] = [];
        if (this.level > 0) {
            await this.ensureLevelLoaded();
            for (const g of this.levelGops) { if (g.t + this.gopDurMs(g) < fromWall) continue; out.push(g); if (out.length >= count) break; }
            return out;
        }
        for (let hn = this.hourNumOf(fromWall); hn <= 23 && out.length < count; hn++) {
            for (const g of await this.ensureHour(hn)) { if (g.t + this.gopDurMs(g) < fromWall) continue; out.push(g); if (out.length >= count) break; }
        }
        return out;
    }

    // ---- bytes ----
    // Raw GOP bytes (cached + in-flight deduped). `priority` fetches are non-cancellable
    // (a seek/render target); background prefetches are cancellable (dropped on a seek).
    getBytes(gop: GopEntry, priority: boolean): Promise<Buffer> {
        const t = gop.t;
        const cached = this.bytesCache.get(t);
        if (cached) return Promise.resolve(cached);
        const ex = this.inFlightBytes.get(t);
        if (ex) return ex;
        const p = this.fetch(gop, priority)
            .then(b => { this.bytesCache.set(t, b); this.recordFetched(gop); this.trimBytes(); return b; })
            .finally(() => { this.inFlightBytes.delete(t); });
        this.inFlightBytes.set(t, p);
        return p;
    }
    private async fetch(gop: GopEntry, priority: boolean): Promise<Buffer> {
        const opt = { cancellable: !priority };
        this.pending.add(gop.t); this.firePending();
        try {
            const data = this.level > 0
                ? await this.api.getLevelGopData(this.level, gop.t, gop.f, gop.o, gop.l, opt)
                : await this.api.getGopData(this.dayParts, gop.f, gop.o, gop.l, opt);
            return Buffer.from(data);
        } finally { this.pending.delete(gop.t); this.firePending(); }
    }
    hasBytes(gop: GopEntry): boolean { return this.bytesCache.has(gop.t); }
    cancelInflight(): void { try { this.api.cancelStaleGops(); } catch { /* */ } }

    private recordFetched(g: GopEntry): void { this.fetched.set(g.t, { start: g.t, end: g.t + this.gopDurMs(g) }); this.firePending(); }
    private trimBytes(): void {
        while (this.bytesCache.size > BYTES_CACHE_MAX) { const k = this.bytesCache.keys().next().value as number; this.bytesCache.delete(k); }
    }
    private firePending(): void { this.onPending?.(); }

    // ---- marker outputs ----
    get pendingGopTimes(): number[] { return Array.from(this.pending); }
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
}
