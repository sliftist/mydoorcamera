// Tiny symmetric RPC over a binary message channel (WebSocket). Wire format is
// cbor-x — so Buffers / typed arrays inside args and results just work, no
// special-casing. Each packet is { type, id }:
//   call   -> { type:"call",   id, method, args }
//   result -> { type:"result", id, value }            (success)
//            { type:"result", id, error:{message,stack} } (handler threw)
// Calling a method returns a promise that resolves with the remote result, or
// rejects with an Error carrying the remote stack. Works the same on both ends.
//
// Isomorphic: no Node-only imports here. Pass in a Channel adapter (see the
// nodeWsChannel / browserWsChannel helpers).

import { encode, decode } from "cbor-x";

export type Handlers = Record<string, (...args: any[]) => Promise<any> | any>;

export interface Channel {
    send(data: Uint8Array): void;
    onMessage(cb: (data: Uint8Array) => void): void;
    onClose(cb: () => void): void;
    close(): void;
}

type Packet =
    | { type: "call"; id: number; method: string; args: any[] }
    | { type: "result"; id: number; value?: any; error?: { message: string; stack?: string } };

export interface Rpc {
    call<T = any>(method: string, ...args: any[]): Promise<T>;
    close(): void;
}

function rpcLog(dir: "→" | "←", type: string, verb: string): void {
    try { console.log(`[rpc] ${dir} ${type} ${verb}`); } catch { /* ignore */ }
}

export function createRpc(channel: Channel, handlers: Handlers = {}): Rpc {
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; method: string }>();

    channel.onMessage(async (data) => {
        let pkt: Packet;
        try { pkt = decode(data as any) as Packet; }
        catch { return; }

        if (pkt.type === "call") {
            rpcLog("←", "call", pkt.method);              // a call arrived for us to handle
            let reply: Packet;
            const handler = handlers[pkt.method];
            if (!handler) {
                reply = { type: "result", id: pkt.id, error: { message: `No such method: ${pkt.method}` } };
            } else {
                try {
                    const value = await handler(...(pkt.args || []));
                    reply = { type: "result", id: pkt.id, value };
                } catch (e: any) {
                    reply = { type: "result", id: pkt.id, error: { message: String(e?.message ?? e), stack: e?.stack } };
                }
            }
            rpcLog("→", "return", pkt.method);            // sending the result back
            try { channel.send(encode(reply)); } catch { /* socket gone */ }
            return;
        }

        if (pkt.type === "result") {
            const p = pending.get(pkt.id);
            if (!p) return;
            rpcLog("←", "return", p.method);              // result arrived for a call we made
            pending.delete(pkt.id);
            if (pkt.error) {
                const err = new Error(pkt.error.message);
                if (pkt.error.stack) err.stack = `Remote error: ${pkt.error.stack}`;
                p.reject(err);
            } else {
                p.resolve(pkt.value);
            }
        }
    });

    channel.onClose(() => {
        for (const p of pending.values()) p.reject(new Error("RPC connection closed"));
        pending.clear();
    });

    return {
        call(method, ...args) {
            return new Promise((resolve, reject) => {
                const id = nextId++;
                pending.set(id, { resolve, reject, method });
                rpcLog("→", "call", method);              // making a call
                try { channel.send(encode({ type: "call", id, method, args })); }
                catch (e) { pending.delete(id); reject(e); }
            });
        },
        close() { channel.close(); },
    };
}

// Adapter for the browser's native WebSocket (set binaryType='arraybuffer').
export function browserWsChannel(ws: WebSocket): Channel {
    ws.binaryType = "arraybuffer";
    return {
        send: (d) => ws.send(d),
        onMessage: (cb) => { ws.addEventListener("message", (ev) => cb(new Uint8Array(ev.data as ArrayBuffer))); },
        onClose: (cb) => { ws.addEventListener("close", cb); },
        close: () => ws.close(),
    };
}
