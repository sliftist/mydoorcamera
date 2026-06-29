// Runtime control flags settable from the client and read by the (separate, Rust) recorder
// process via a small shared JSON file. Currently just `alwaysEncode`: when true the recorder
// encodes EVERY GOP (bypassing activity-gating) — a deliberate stress test to see whether the
// hardware encoder keeps up under continuous activity.

import { promises as fsp } from "fs";
import * as path from "path";
import { DATA_DIR } from "./config";

export type ServerControl = { alwaysEncode: boolean };

const CONTROL_FILE = path.join(path.dirname(DATA_DIR), "control.json"); // /var/lib/mydoorcamera/control.json
const DEFAULTS: ServerControl = { alwaysEncode: false };

export async function readControl(): Promise<ServerControl> {
    try { return { ...DEFAULTS, ...JSON.parse(await fsp.readFile(CONTROL_FILE, "utf8")) }; }
    catch { return { ...DEFAULTS }; }
}

export async function writeControl(c: ServerControl): Promise<ServerControl> {
    const next: ServerControl = { ...DEFAULTS, ...c };
    // Compact, fixed shape so the recorder can read it with a trivial parse.
    await fsp.writeFile(CONTROL_FILE, JSON.stringify({ alwaysEncode: !!next.alwaysEncode }));
    return next;
}
