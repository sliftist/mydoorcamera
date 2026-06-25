// Browser-side client for the camera server. Wraps the isomorphic cbor-x RPC
// over the native WebSocket. Connecting requires the self-signed cert to have
// been accepted (open https://<ip>:<port>/ once), otherwise the socket errors.

import { createRpc, browserWsChannel, Rpc } from "../src/rpc";

export type GopEntry = { t: number; f: string; o: number; l: number; n: number };
export type DayCoverage = { dayStartMs: number; dayEndMs: number; ranges: { start: number; end: number }[] };

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

    constructor(public ip: string, public port = 8443) {}

    get certUrl(): string { return `https://${this.ip}:${this.port}/`; }

    async connect(password: string): Promise<void> {
        const ws = new WebSocket(`wss://${this.ip}:${this.port}`);
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => {
                const e: any = new Error("Couldn't reach the camera server — the self-signed certificate probably isn't accepted yet.");
                e.needsCert = true; // signals the UI to surface the certificate link
                reject(e);
            };
        });
        this.rpc = createRpc(browserWsChannel(ws), {});
        await this.rpc.call("login", password); // rejects on wrong password / blacklist
    }

    listChildren(parts: string[]): Promise<string[]> { return this.rpc!.call("listChildren", parts); }
    getAvailableDays(): Promise<string[]> { return this.rpc!.call("getAvailableDays"); }
    getDayCoverage(parts: string[]): Promise<DayCoverage> { return this.rpc!.call("getDayCoverage", parts); }
    getHourIndex(parts: string[]): Promise<GopEntry[]> { return this.rpc!.call("getHourIndex", parts); }
    getGopData(parts: string[], file: string, off: number, len: number): Promise<Uint8Array> {
        return this.rpc!.call("getGopData", parts, file, off, len);
    }
    getStats(): Promise<Stats> { return this.rpc!.call("getStats"); }
}
