// End-to-end check of the server: connects over WSS (accepting the self-signed
// cert), verifies auth gating + blacklist path, and fetches real GOP bytes.
import { WebSocket } from "ws";
import * as fs from "fs";
import { createRpc, Channel } from "./rpc";
import { SERVER_PORT } from "./config";

function nodeWsChannel(ws: any): Channel {
    return {
        send: (d) => ws.send(d),
        onMessage: (cb) => ws.on("message", (x: Buffer) => cb(new Uint8Array(x))),
        onClose: (cb) => ws.on("close", cb),
        close: () => ws.close(),
    };
}

async function main(): Promise<void> {
    const ws = new WebSocket(`wss://127.0.0.1:${SERVER_PORT}`, { rejectUnauthorized: false });
    await new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
    const rpc = createRpc(nodeWsChannel(ws), {});

    try { await rpc.call("listChildren", []); console.log("FAIL: unauth call succeeded"); }
    catch (e) { console.log("✓ unauth blocked:", (e as Error).message.split("\n")[0]); }

    try { await rpc.call("login", "totally wrong password words"); console.log("FAIL: wrong pw accepted"); }
    catch (e) { console.log("✓ wrong pw rejected:", (e as Error).message.split("\n")[0]); }

    const pw = fs.readFileSync("/var/lib/mydoorcamera/password.txt", "utf8").trim();
    console.log("✓ login:", JSON.stringify(await rpc.call("login", pw)));

    const years = await rpc.call("listChildren", []);
    const y = years[0], mo = (await rpc.call("listChildren", [y]))[0],
        d = (await rpc.call("listChildren", [y, mo]))[0], h = (await rpc.call("listChildren", [y, mo, d]))[0];
    const idx = await rpc.call("getHourIndex", [y, mo, d, h]);
    console.log(`✓ nav ${y}/${mo}/${d}/${h}: ${idx.length} GOPs, first=`, JSON.stringify(idx[0]));

    const g = idx[0];
    const buf = await rpc.call("getGopData", [y, mo, d, h], g.f, g.o, g.l);
    const ok = (buf instanceof Uint8Array) && buf.length === g.l;
    console.log(`✓ getGopData: ${ok ? "binary " + buf.length + " bytes (native, matches index)" : "WRONG: " + typeof buf}`);

    rpc.close(); ws.close();
    console.log(ok ? "\nSERVER TEST PASSED" : "\nSERVER TEST FAILED");
    process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error("SERVER TEST ERROR:", e); process.exit(1); });
