// Runtime control flags settable by the server and read by the (separate, Rust) recorder process
// via a small shared JSON file. The recorder encodes EVERY GOP (bypassing activity-gating) when
// either flag is set:
//   alwaysEncode  - manual stress-test toggle from the client.
//   liveStreaming - set automatically while >=1 client is watching the live stream, so the live
//                   view is smooth/continuous; cleared when nobody is watching (back to gating).

import { promises as fsp } from "fs";
import * as path from "path";
import { DATA_DIR } from "./config";

export type ServerControl = { alwaysEncode: boolean; liveStreaming: boolean };

const CONTROL_FILE = path.join(path.dirname(DATA_DIR), "control.json"); // /var/lib/mydoorcamera/control.json
const DEFAULTS: ServerControl = { alwaysEncode: false, liveStreaming: false };

export async function readControl(): Promise<ServerControl> {
    try { return { ...DEFAULTS, ...JSON.parse(await fsp.readFile(CONTROL_FILE, "utf8")) }; }
    catch { return { ...DEFAULTS }; }
}

// Read-modify-write so the two flags (set by different code paths) don't clobber each other.
export async function writeControl(patch: Partial<ServerControl>): Promise<ServerControl> {
    const next: ServerControl = { ...(await readControl()), ...patch };
    await fsp.writeFile(CONTROL_FILE, JSON.stringify({ alwaysEncode: !!next.alwaysEncode, liveStreaming: !!next.liveStreaming }));
    return next;
}
