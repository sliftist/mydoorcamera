// HTTPS + WSS server daemon (separate process from capture). Serves the indexed
// video over the cbor-x RPC protocol. Self-signed cert; the browser must accept
// it once by opening https://<ip>:<port>/ in a tab. Run via typenode.

import * as https from "https";
import { promises as fsp } from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { WebSocketServer } from "ws";
import { SERVER_PORT, CERT_DIR, DATA_DIR, PASSWORD_WORD_COUNT } from "./config";

function firstLanIp(): string {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const i of ifaces[name] || []) {
            if (i.family === "IPv4" && !i.internal) return i.address;
        }
    }
    return "127.0.0.1";
}
import { createRpc, Channel, Rpc } from "./rpc";
import { listChildren, combineHour, readGopBytes, getAvailableDays, getDayCoverage, latestIdxFile, readIdxIncremental, dataReady, daySignature, getLevelsInfo, getLevelCoverage, readLevelGops, readLevelGopData, getGopBytesAt, getRawIndex } from "./storage";
import { getPassword, checkPassword, isBlacklisted, recordFailedAttempt } from "./auth";
import { getSystemStats, readEncoderStats } from "./stats";
import { getTimezone } from "./timezone";

// Match the capture daemon's zone so day boundaries / folders line up.
process.env.TZ = getTimezone();

async function ensureCert(): Promise<{ key: Buffer; cert: Buffer }> {
    const keyPath = path.join(CERT_DIR, "key.pem");
    const certPath = path.join(CERT_DIR, "cert.pem");
    const exists = async (p: string): Promise<boolean> => { try { await fsp.access(p); return true; } catch { return false; } };
    if (!(await exists(keyPath)) || !(await exists(certPath))) {
        await fsp.mkdir(CERT_DIR, { recursive: true });
        const ip = firstLanIp();
        execSync(
            `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 3650 -nodes ` +
            `-subj "/CN=mydoorcamera" -addext "subjectAltName=IP:${ip},IP:127.0.0.1,DNS:localhost"`,
            { stdio: "ignore" },
        );
        console.log(`[server] generated self-signed cert (SAN IP:${ip})`);
    }
    return { key: await fsp.readFile(keyPath), cert: await fsp.readFile(certPath) };
}

function nodeWsChannel(ws: import("ws").WebSocket): Channel {
    return {
        send: (d) => ws.send(d),
        onMessage: (cb) => ws.on("message", (data: Buffer) => cb(new Uint8Array(data))),
        onClose: (cb) => ws.on("close", cb),
        close: () => ws.close(),
    };
}

const CERT_PAGE =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>mydoorcamera</title></head>` +
    `<body style="font-family:system-ui;background:#0c0f14;color:#eee;padding:48px">` +
    `<h1>mydoorcamera server</h1><p>Certificate accepted &#10003; — you can close this tab and return to the app.</p>` +
    `</body></html>`;

async function start(): Promise<void> {
    const { key, cert } = await ensureCert();
    const ip = firstLanIp();
    const password = await getPassword();
    console.log("\n=========== mydoorcamera server ===========");
    console.log(`Accept cert here:  https://${ip}:${SERVER_PORT}/`);
    console.log(`WSS endpoint:      wss://${ip}:${SERVER_PORT}`);
    console.log(`PASSWORD (${PASSWORD_WORD_COUNT} words): ${password}`);
    console.log("===========================================\n");

    const httpsServer = https.createServer({ key, cert }, (_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(CERT_PAGE);
    });

    const wss = new WebSocketServer({ server: httpsServer });
    wss.on("connection", async (ws, req) => {
        const clientIp = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
        if (await isBlacklisted(clientIp)) { ws.close(); return; }

        let authed = false;
        const requireAuth = () => { if (!authed) throw new Error("not authenticated"); };

        // Live stream + day-watch state (server pushes by calling back the client).
        let rpc: Rpc;
        let streamTimer: ReturnType<typeof setInterval> | undefined;
        let stream: { parts: string[]; file: string; offset: number } | undefined;
        const watched = new Map<string, string>(); // "Y/M/D" -> last signature
        let watchTimer: ReturnType<typeof setInterval> | undefined;

        function stopStream(): void {
            if (streamTimer) { clearInterval(streamTimer); streamTimer = undefined; }
            stream = undefined;
        }
        let streamPolling = false, watchPolling = false; // re-entrancy guards for the async pollers
        async function pollStream(): Promise<void> {
            if (!stream || streamPolling) return;
            streamPolling = true;
            try {
                const live = await latestIdxFile(stream.parts);
                if (!live || !stream) return;
                if (live !== stream.file) { stream.file = live; stream.offset = 0; } // hour rolled / restart
                const { records, ends } = await readIdxIncremental(stream.parts, stream.file, stream.offset);
                for (let i = 0; i < records.length; i++) {
                    const r = records[i];
                    if (!stream) break;
                    if (!(await dataReady(stream.parts, r.f, r.o, r.l))) break; // not flushed yet — retry next tick
                    const bytes = await readGopBytes(stream.parts, r.f, r.o, r.l);
                    rpc.call("onStreamData", { t: r.t, e: r.e, n: r.n }, bytes).catch(() => { /* */ });
                    stream.offset = ends[i];
                }
            } finally { streamPolling = false; }
        }
        async function pollWatched(): Promise<void> {
            if (watchPolling) return;
            watchPolling = true;
            try {
                for (const day of watched.keys()) {
                    const parts = day.split("/");
                    const sig = await daySignature(parts);
                    if (sig !== watched.get(day)) {
                        watched.set(day, sig);
                        rpc.call("onRangesUpdated", day, await getDayCoverage(parts)).catch(() => { /* */ });
                    }
                }
            } finally { watchPolling = false; }
        }

        ws.on("close", () => { stopStream(); if (watchTimer) clearInterval(watchTimer); });

        rpc = createRpc(nodeWsChannel(ws), {
            async login(pw: string) {
                if (await isBlacklisted(clientIp)) throw new Error("blacklisted");
                if (await checkPassword(pw)) { authed = true; return { ok: true }; }
                const nowBlack = await recordFailedAttempt(clientIp);
                throw new Error(nowBlack ? "blacklisted" : "wrong password");
            },
            async listChildren(parts: string[]) { requireAuth(); return listChildren(parts); },
            async getAvailableDays() { requireAuth(); return getAvailableDays(); },
            async getDayCoverage(parts: string[]) { requireAuth(); return getDayCoverage(parts); },
            async getHourIndex(parts: string[]) { requireAuth(); return combineHour(parts); },
            async getGopData(parts: string[], file: string, off: number, len: number) {
                requireAuth();
                return readGopBytes(parts, file, off, len); // Buffer travels natively over cbor-x
            },
            // ---- thinning levels ----
            async getLevels() { requireAuth(); return getLevelsInfo(); },
            async getLevelCoverage(level: number, fromMs: number, toMs: number, buckets?: number) { requireAuth(); return getLevelCoverage(level, fromMs, toMs, buckets || 1440); },
            async getLevelIndex(level: number, fromMs: number, toMs: number) { requireAuth(); return { gops: await readLevelGops(level, fromMs, toMs), badRanges: [] }; },
            async getLevelGopData(level: number, t: number, file: string, off: number, len: number) { requireAuth(); return readLevelGopData(level, t, file, off, len); },
            async getGopBytesAt(level: number, t: number) { requireAuth(); return getGopBytesAt(level, t); }, // GOP bytes by (level,t) — for client thumbnail decoding
            async getRawIndex(level: number, fromMs: number, toMs: number) { requireAuth(); return getRawIndex(level, fromMs, toMs); },

            async serverInfo() { requireAuth(); return { ip, port: SERVER_PORT }; },
            async getStats() { requireAuth(); return { system: await getSystemStats(DATA_DIR), encoder: await readEncoderStats() }; },

            // ---- live streaming ----
            async startStream(day: string) {
                requireAuth();
                stopStream();
                const parts = day.split("/");
                // Start at the live edge: skip the existing backlog of the current file.
                const live = await latestIdxFile(parts);
                let offset = 0;
                if (live) { try { offset = (await readIdxIncremental(parts, live, 0)).nextByte; } catch { offset = 0; } }
                stream = { parts, file: live || "", offset };
                streamTimer = setInterval(() => void pollStream(), 500);
                return { ok: true };
            },
            async stopStream() { stopStream(); return { ok: true }; },

            // ---- watch a day for growing coverage ----
            async watchDay(day: string) {
                requireAuth();
                watched.set(day, await daySignature(day.split("/")));
                if (!watchTimer) watchTimer = setInterval(() => void pollWatched(), 2000);
                return { ok: true };
            },
            async unwatchDay(day: string) { watched.delete(day); return { ok: true }; },
        });
    });

    httpsServer.listen(SERVER_PORT, () => console.log(`[server] listening on :${SERVER_PORT}`));
}

start().catch(e => { console.error("[server] failed to start:", e); process.exit(1); });
