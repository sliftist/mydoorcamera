// Browser-side client for the camera server. Wraps the isomorphic cbor-x RPC
// over the native WebSocket. Connecting requires the self-signed cert to have
// been accepted (open https://<ip>:<port>/ once), otherwise the socket errors.

import { createRpc, browserWsChannel, Rpc } from "../../src/rpc";

export type Range = { start: number; end: number };
export type GopEntry = { t: number; e: number; f: string; o: number; l: number; n: number; a: number; aMax: number };
export type HourIndex = { gops: GopEntry[]; badRanges: Range[] };
export type DayCoverage = { dayStartMs: number; dayEndMs: number; ranges: Range[]; badRanges: Range[]; activity: number[] };
export type LevelCoverage = { fromMs: number; toMs: number; ranges: Range[]; badRanges: Range[]; activity: number[] };
export type LevelInfo = {
    level: number; timePerSec: number; gopSpanSec: number;
    budgetBytes: number; usedBytes: number; earliestMs: number; latestMs: number;
};

export type Stats = {
    system: {
        cpuPct: number; loadAvg: number; cores: number;
        ramUsedBytes: number; ramTotalBytes: number;
        diskUsedBytes: number; diskTotalBytes: number;
        netRxBps: number; netTxBps: number;
    };
    encoder: { fps: number; cpuPct: number; updatedMs: number } | null;
};

export class CameraApi {
    private rpc: Rpc | undefined;
    private password = "";
    private alive = true;
    private connected = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    // Optional hooks for the UI: connection up/down, and "just reconnected".
    onStatus: ((connected: boolean) => void) | undefined;
    onReconnect: (() => void) | undefined;
    // Server-push routing.
    private streamCb: ((meta: any, bytes: Uint8Array) => void) | undefined;
    private watchCbs = new Map<string, (cov: DayCoverage) => void>();
    // Inbound-data accounting: total bytes ever received + a 60s sliding log for rate.
    private bytesTotal = 0;
    private byteLog: { t: number; n: number }[] = [];
    private gopsLoaded = 0; // GOPs fetched/streamed this session

    constructor(public ip: string, public port = 8443) {}

    get certUrl(): string { return `https://${this.ip}:${this.port}/`; }

    // First connect — surfaces cert/password errors to the UI. After this
    // succeeds, the socket auto-reconnects (re-login included) on any drop.
    async connect(password: string): Promise<void> {
        this.password = password;
        this.alive = true;
        await this.open();
    }

    // Total bytes received from the server (monotonic) and the rolling 60s rate.
    get loadedBytes(): number { return this.bytesTotal; }
    get loadedGops(): number { return this.gopsLoaded; }
    loadRateBps(): number {
        const cut = Date.now() - 60_000;
        let sum = 0;
        for (const e of this.byteLog) if (e.t >= cut) sum += e.n;
        return sum / 60;
    }
    private recordBytes(n: number): void {
        if (!n) return;
        this.bytesTotal += n;
        const now = Date.now();
        this.byteLog.push({ t: now, n });
        const cut = now - 60_000;
        while (this.byteLog.length && this.byteLog[0].t < cut) this.byteLog.shift();
    }

    private async open(): Promise<void> {
        const ws = new WebSocket(`wss://${this.ip}:${this.port}`);
        // Count every inbound message (RPC replies + live pushes) as loaded data.
        ws.addEventListener("message", (ev: MessageEvent) => {
            const d: any = ev.data;
            this.recordBytes(d instanceof ArrayBuffer ? d.byteLength : (d?.byteLength ?? d?.size ?? (typeof d === "string" ? d.length : 0)));
        });
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => {
                const e: any = new Error("Couldn't reach the camera server — the self-signed certificate probably isn't accepted yet.");
                e.needsCert = true; // signals the UI to surface the certificate link
                reject(e);
            };
        });
        const rpc = createRpc(browserWsChannel(ws), {
            // Server pushes live GOPs here while streaming.
            onStreamData: async (meta: any, bytes: Uint8Array) => {
                if (this.streamCb) { this.gopsLoaded++; this.streamCb(meta, bytes); }
                else this.rpc?.call("stopStream").catch(() => { /* */ }); // never get stuck streaming
            },
            // Server pushes a day's new coverage as capture grows it.
            onRangesUpdated: async (day: string, cov: DayCoverage) => { this.watchCbs.get(day)?.(cov); },
        });
        await rpc.call("login", this.password); // rejects on wrong password / blacklist
        this.rpc = rpc;
        this.connected = true;
        this.onStatus?.(true);
        ws.addEventListener("close", () => this.onSocketClose());
    }

    private onSocketClose(): void {
        if (!this.connected) return;
        this.connected = false;
        this.rpc = undefined;
        this.onStatus?.(false);
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (!this.alive || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = undefined;
            try { await this.open(); this.onReconnect?.(); }
            catch { this.scheduleReconnect(); } // server still down / restarting — keep trying
        }, 2000);
    }

    close(): void {
        this.alive = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.rpc?.close();
    }

    private call<T = any>(method: string, ...args: any[]): Promise<T> {
        if (!this.rpc) return Promise.reject(new Error("not connected"));
        return this.rpc.call<T>(method, ...args);
    }

    listChildren(parts: string[]): Promise<string[]> { return this.call("listChildren", parts); }
    getAvailableDays(): Promise<string[]> { return this.call("getAvailableDays"); }
    getDayCoverage(parts: string[]): Promise<DayCoverage> { return this.call("getDayCoverage", parts); }
    getHourIndex(parts: string[]): Promise<HourIndex> { return this.call("getHourIndex", parts); }
    getGopData(parts: string[], file: string, off: number, len: number): Promise<Uint8Array> {
        return this.call<Uint8Array>("getGopData", parts, file, off, len).then(b => { this.gopsLoaded++; return b; });
    }
    getStats(): Promise<Stats> { return this.call("getStats"); }

    // ---- thinning levels ----
    getLevels(): Promise<LevelInfo[]> { return this.call("getLevels"); }
    getLevelCoverage(level: number, fromMs: number, toMs: number, buckets?: number): Promise<LevelCoverage> {
        return this.call("getLevelCoverage", level, fromMs, toMs, buckets);
    }
    getLevelIndex(level: number, fromMs: number, toMs: number): Promise<HourIndex> {
        return this.call("getLevelIndex", level, fromMs, toMs);
    }
    getLevelGopData(level: number, t: number, file: string, off: number, len: number): Promise<Uint8Array> {
        return this.call<Uint8Array>("getLevelGopData", level, t, file, off, len).then(b => { this.gopsLoaded++; return b; });
    }
    // Raw on-disk index bytes for a period — parsed client-side (see indexBuffer.ts).
    getRawIndex(level: number, fromMs: number, toMs: number): Promise<Uint8Array> {
        return this.call("getRawIndex", level, fromMs, toMs);
    }

    // ---- live streaming ----
    async startStream(day: string, cb: (meta: any, bytes: Uint8Array) => void): Promise<void> {
        this.streamCb = cb;
        await this.call("startStream", day);
    }
    async stopStream(): Promise<void> {
        this.streamCb = undefined;
        if (this.rpc) await this.call("stopStream");
    }

    // ---- watch a day for growing coverage ----
    async watchDay(day: string, cb: (cov: DayCoverage) => void): Promise<void> {
        this.watchCbs.set(day, cb);
        await this.call("watchDay", day);
    }
    unwatchDay(day: string): void {
        this.watchCbs.delete(day);
        if (this.rpc) this.call("unwatchDay", day).catch(() => { /* */ });
    }
}
