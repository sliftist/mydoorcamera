// Browser-side client for the camera server. Wraps the isomorphic cbor-x RPC
// over the native WebSocket. Connecting requires the self-signed cert to have
// been accepted (open https://<ip>:<port>/ once), otherwise the socket errors.

import { createRpc, browserWsChannel, Rpc } from "../src/rpc";

export type Range = { start: number; end: number };
export type GopEntry = { t: number; e: number; f: string; o: number; l: number; n: number };
export type HourIndex = { gops: GopEntry[]; badRanges: Range[] };
export type DayCoverage = { dayStartMs: number; dayEndMs: number; ranges: Range[]; badRanges: Range[] };

export type Stats = {
    system: {
        cpuPct: number; loadAvg: number; cores: number;
        ramUsedBytes: number; ramTotalBytes: number;
        diskUsedBytes: number; diskTotalBytes: number;
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

    constructor(public ip: string, public port = 8443) {}

    get certUrl(): string { return `https://${this.ip}:${this.port}/`; }

    // First connect — surfaces cert/password errors to the UI. After this
    // succeeds, the socket auto-reconnects (re-login included) on any drop.
    async connect(password: string): Promise<void> {
        this.password = password;
        this.alive = true;
        await this.open();
    }

    private async open(): Promise<void> {
        const ws = new WebSocket(`wss://${this.ip}:${this.port}`);
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => {
                const e: any = new Error("Couldn't reach the camera server — the self-signed certificate probably isn't accepted yet.");
                e.needsCert = true; // signals the UI to surface the certificate link
                reject(e);
            };
        });
        const rpc = createRpc(browserWsChannel(ws), {});
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
        return this.call("getGopData", parts, file, off, len);
    }
    getStats(): Promise<Stats> { return this.call("getStats"); }
}
