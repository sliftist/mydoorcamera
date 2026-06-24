// Validates the storage -> mp4-typescript -> playable MP4 path in Node, so we
// know the captured GOPs are correct before the browser ever touches them.
// Run: node -r ./node_modules/typenode/index.js ./src/muxtest.ts [gopCount]

import * as fs from "fs";
import { H264toMP4 } from "mp4-typescript";
import { FPS } from "./config";
import { listChildren, readHourIndex, readGopBytes } from "./storage";
import { splitFramedNals } from "./annexb";

const OUT = "/var/lib/mydoorcamera/muxtest.mp4";

async function main(): Promise<void> {
    // Descend to the first available Y/M/D/H folder that has an index.
    const y = listChildren([])[0];
    const mo = y && listChildren([y])[0];
    const d = mo && listChildren([y, mo])[0];
    const h = d && listChildren([y, mo, d])[0];
    if (!h) throw new Error("no captured data found under DATA_DIR");
    const parts = [y, mo, d, h];

    const index = readHourIndex(parts);
    if (!index.length) throw new Error("hour has no GOPs in index");

    const count = Number(process.argv[2]) || Math.min(10, index.length);
    const gops = index.slice(0, count);

    let nals: Buffer[] = [];
    for (const g of gops) {
        nals.push(...splitFramedNals(readGopBytes(parts, g.f, g.o, g.l)));
    }

    const res = await H264toMP4({
        buffer: nals,
        frameDurationInSeconds: 1 / FPS,
        width: 1920,
        height: 1080,
    });
    fs.writeFileSync(OUT, res.buffer);
    console.log("MUX OK:", JSON.stringify({
        hour: parts.join("/"),
        gops: gops.length,
        frameCount: res.frameCount,
        keyFrameCount: res.keyFrameCount,
        mp4Bytes: res.buffer.length,
        out: OUT,
    }));
}

main().catch(e => { console.error("MUX FAILED:", e); process.exit(1); });
