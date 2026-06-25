// Activity worker (separate daemon — keeps the critical capture path untouched).
// Backfills each GOP's `activity` float: hardware-decodes the keyframe to a tiny
// grayscale frame and measures the fraction of pixels that changed (beyond a
// noise floor) vs the previous keyframe. Throttled so it never starves the live
// encoder. Run via typenode.

import { spawn } from "child_process";
import { getTimezone } from "./timezone";
process.env.TZ = getTimezone();
import { findPendingActivity, writeActivity, readGopBytes, GopEntry } from "./storage";
import { splitFramedNals } from "./annexb";

const W = 64, H = 36, FRAME = W * H;   // tiny grayscale frame
const NOISE = 16;                       // per-pixel change below this is treated as sensor noise
const BATCH = 4;                        // keyframes per decode pass (4/s keeps up with live + backfills,
const PERIOD_MS = 1000;                 // while leaving the shared codec block mostly free for the encoder
const START_CODE = Buffer.from([0, 0, 0, 1]);

let prevFrame: Buffer | undefined;

// Extract SPS+PPS+IDR of a GOP as an Annex-B access unit.
function keyframeAU(parts: string[], g: GopEntry): Buffer {
    const out: Buffer[] = [];
    for (const n of splitFramedNals(readGopBytes(parts, g.f, g.o, g.l))) {
        const t = n[0] & 0x1f;
        if (t === 7 || t === 8 || t === 5) { out.push(START_CODE, n); }
    }
    return Buffer.concat(out);
}

// Software-decode (avdec_h264) a concatenated keyframe stream to GRAY8 WxH
// frames. Software (CPU) is used deliberately: the hardware decoder shares the
// bcm2835 codec block with the live encoder and dropped it 30->24fps, whereas
// CPU decode (~35ms/keyframe) runs on spare cores and leaves the encoder at 30.
function decode(stream: Buffer): Promise<Buffer[]> {
    return new Promise(resolve => {
        const gst = spawn("gst-launch-1.0", [
            "-q", "fdsrc", "fd=0", "!", "h264parse", "!", "avdec_h264", "!",
            "videoconvert", "!", "videoscale", "!", `video/x-raw,format=GRAY8,width=${W},height=${H}`, "!",
            "fdsink", "fd=1",
        ], { stdio: ["pipe", "pipe", "ignore"] });
        const chunks: Buffer[] = [];
        gst.stdout.on("data", (c: Buffer) => chunks.push(c));
        gst.on("close", () => {
            const all = Buffer.concat(chunks);
            const frames: Buffer[] = [];
            for (let i = 0; i + FRAME <= all.length; i += FRAME) frames.push(all.subarray(i, i + FRAME));
            resolve(frames);
        });
        gst.on("error", () => resolve([]));
        gst.stdin.on("error", () => { /* ignore EPIPE if decoder died */ });
        gst.stdin.write(stream);
        gst.stdin.end();
    });
}

function activityOf(cur: Buffer, prev?: Buffer): number {
    if (!prev) return 0;
    let changed = 0;
    for (let i = 0; i < FRAME; i++) if (Math.abs(cur[i] - prev[i]) > NOISE) changed++;
    return changed / FRAME;
}

async function loop(): Promise<void> {
    let pending: ReturnType<typeof findPendingActivity> = [];
    try { pending = findPendingActivity(BATCH); } catch { /* */ }
    if (!pending.length) { setTimeout(loop, PERIOD_MS); return; }

    let frames: Buffer[] = [];
    try { frames = await decode(Buffer.concat(pending.map(p => keyframeAU(p.parts, p.gop)))); }
    catch { /* */ }

    if (frames.length === 0) {
        // Couldn't decode the head GOP — mark it 0 so we make forward progress.
        try { writeActivity(pending[0].parts, pending[0].idxFile, pending[0].start, 0); } catch { /* */ }
        setTimeout(loop, PERIOD_MS); return;
    }
    const k = Math.min(frames.length, pending.length);
    for (let i = 0; i < k; i++) {
        const a = activityOf(frames[i], prevFrame);
        prevFrame = frames[i];
        try { writeActivity(pending[i].parts, pending[i].idxFile, pending[i].start, a); } catch { /* */ }
    }
    setTimeout(loop, PERIOD_MS); // (records k.. retried next pass)
}

console.log("[activity] worker started");
loop();
