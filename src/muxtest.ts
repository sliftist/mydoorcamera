// Validates the storage -> mp4-typescript -> playable MP4 path in Node.
// Run: node -r ./node_modules/typenode/index.js ./src/muxtest.ts [gopCount]

import * as fs from "fs";
import { H264toMP4 } from "mp4-typescript";
import { FPS } from "./config";
import { listChildren, combineHour, readGopBytes, GopEntry } from "./storage";
import { splitFramedNals } from "./annexb";

const OUT = "/var/lib/mydoorcamera/muxtest.mp4";
const pad2 = (n: number) => String(n).padStart(2, "0");

async function main(): Promise<void> {
    const y = (await listChildren([]))[0];
    const mo = y && (await listChildren([y]))[0];
    const d = mo && (await listChildren([y, mo]))[0];
    if (!d) throw new Error("no captured data found under DATA_DIR");
    const dayParts = [y, mo, d];

    let gops: GopEntry[] = [];
    for (let h = 0; h < 24; h++) {
        const r = await combineHour([...dayParts, pad2(h)]);
        if (r.gops.length) { gops = r.gops; break; }
    }
    if (!gops.length) throw new Error("day has no GOPs");

    const count = Number(process.argv[2]) || Math.min(10, gops.length);
    const take = gops.slice(0, count);

    let nals: Buffer[] = [];
    for (const g of take) nals.push(...splitFramedNals(await readGopBytes(dayParts, g.f, g.o, g.l)));

    const res = await H264toMP4({ buffer: nals, frameDurationInSeconds: 1 / FPS, width: 1920, height: 1080 });
    fs.writeFileSync(OUT, res.buffer);
    console.log("MUX OK:", JSON.stringify({
        day: dayParts.join("/"), gops: take.length,
        frameCount: res.frameCount, keyFrameCount: res.keyFrameCount, mp4Bytes: res.buffer.length, out: OUT,
    }));
}

main().catch(e => { console.error("MUX FAILED:", e); process.exit(1); });
