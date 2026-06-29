// Thinning worker (separate daemon — see docs/thinning.md). Builds the cascading
// thinned levels L1..L4: each L-level GOP is the keyframes of 30 consecutive
// level-(L-1) GOPs, re-encoded (software x264) into one normal 30-frame GOP that
// plays in ~1s and covers 30^L real seconds. Generation is window-aligned and
// resumable: on startup it recovers each level's cursor from its existing data.
// Run via typenode.

import { spawn } from "child_process";
import { getTimezone } from "./timezone";
process.env.TZ = getTimezone();
import { THIN_LEVELS, THIN_BITRATE, THIN_MIN_QP, THIN_MAX_QP, levelGopSpanSec } from "./config";
import {
    GopEntry, LevelWriter, readLevelGops, readLevelGopAt, levelTimeBounds,
} from "./storage";
import { AnnexBSplitter, splitFramedNals } from "./annexb";

const PERIOD_MS = 5000;            // how often we look for new windows to build
const WINDOWS_PER_PASS = 30;       // cap work per level per pass (rest picked up next tick)
const START_CODE = Buffer.from([0, 0, 0, 1]);

const writers: LevelWriter[] = [];
const cursor: (number | null)[] = []; // next window-start (epoch ms) per level
const lastEncoded: (number | undefined)[] = []; // start time of the last encoded GOP per level (no-change ref)
for (let l = 0; l <= THIN_LEVELS; l++) { writers.push(new LevelWriter(l)); cursor.push(null); lastEncoded.push(undefined); }

// SPS+PPS+IDR of a source GOP as an Annex-B access unit (one decodable frame).
async function keyframeAU(srcLevel: number, g: GopEntry): Promise<Buffer> {
    const out: Buffer[] = [];
    for (const n of splitFramedNals(await readLevelGopAt(srcLevel, g))) {
        const t = n[0] & 0x1f;
        if (t === 7 || t === 8 || t === 5) out.push(START_CODE, n);
    }
    return Buffer.concat(out);
}

// Decode a concatenated keyframe stream and re-encode it on the GPU
// (v4l2h264enc, same hardware encoder as capture) into one 30-frame GOP. Returns
// the GOP's NALs ordered [sps, pps, frame, frame, ...]. The HW encoder emits one
// slice per frame and honours h264_i_frame_period, so the frame count is clean.
function reencode(annexb: Buffer): Promise<Buffer[]> {
    return new Promise(resolve => {
        const gst = spawn("gst-launch-1.0", [
            "-q", "fdsrc", "fd=0", "!", "h264parse", "!", "avdec_h264", "!",
            "videoconvert", "!", "video/x-raw,format=I420", "!",
            // Near-lossless: max bitrate + a low QP floor, and a QP ceiling so the
            // VBR rate-controller can't crush the cold IDR (first frame of each
            // fresh 30-frame encode) — that was the start-of-group blockiness.
            "v4l2h264enc", `extra-controls=encode,video_bitrate=${THIN_BITRATE},h264_i_frame_period=30,h264_minimum_qp_value=${THIN_MIN_QP},h264_maximum_qp_value=${THIN_MAX_QP}`, "!",
            "video/x-h264,level=(string)4.2,profile=high", "!",
            "h264parse", "config-interval=1", "!",
            "video/x-h264,stream-format=byte-stream,alignment=au", "!",
            "fdsink", "fd=1",
        ], { stdio: ["pipe", "pipe", "ignore"] });
        const splitter = new AnnexBSplitter();
        let sps: Buffer | undefined, pps: Buffer | undefined;
        const frames: Buffer[] = [];
        const onNal = (nal: Buffer) => {
            const t = nal[0] & 0x1f;
            if (t === 7) sps = nal; else if (t === 8) pps = nal; else if (t === 5 || t === 1) frames.push(nal);
        };
        gst.stdout.on("data", (c: Buffer) => { for (const n of splitter.push(c)) onNal(n); });
        gst.on("close", () => {
            for (const n of splitter.flush()) onNal(n);
            const out: Buffer[] = [];
            if (sps) out.push(sps);
            if (pps) out.push(pps);
            out.push(...frames);
            resolve(out);
        });
        gst.on("error", () => resolve([]));
        gst.stdin.on("error", () => { /* ignore EPIPE if encoder died */ });
        gst.stdin.write(annexb);
        gst.stdin.end();
    });
}

// Build any windows of `level` that the source (level-1) has fully passed.
async function buildLevel(level: number): Promise<boolean> {
    const span = levelGopSpanSec(level) * 1000;
    const srcLevel = level - 1;
    const srcBounds = await levelTimeBounds(srcLevel);
    if (!srcBounds.latest) return false; // no source yet — ramp-up

    if (cursor[level] == null) {
        const mine = await levelTimeBounds(level);
        // Resume at the window after our last data, else start at the source's first window.
        cursor[level] = mine.latest ? Math.floor(mine.latest / span) * span : Math.floor(srcBounds.earliest / span) * span;
    }
    const from = cursor[level]!;
    if (from + span > srcBounds.latest) return false; // next window not fully available yet

    const passTo = Math.min(Math.floor(srcBounds.latest / span) * span, from + span * WINDOWS_PER_PASS);
    const srcAll = await readLevelGops(srcLevel, from, passTo);
    let i = 0;
    let did = false;
    for (let ws = from; ws + span <= srcBounds.latest && ws < passTo; ws += span) {
        const we = ws + span;
        const win: GopEntry[] = [];
        while (i < srcAll.length && srcAll[i].t < we) { if (srcAll[i].t >= ws) win.push(srcAll[i]); i++; }
        if (!win.length) { cursor[level] = we; continue; }
        // Only active (has-video, l>0) source GOPs contribute keyframes; no-change source
        // GOPs carry no bytes.
        const active = win.filter(g => g.l > 0);
        if (active.length) {
            const annexb = Buffer.concat(await Promise.all(active.map(g => keyframeAU(srcLevel, g))));
            const gop = annexb.length ? await reencode(annexb) : [];
            const frameCount = gop.filter(n => { const t = n[0] & 0x1f; return t === 5 || t === 1; }).length;
            if (frameCount > 0) {
                const avgs = active.map(g => g.a).filter(a => a >= 0);
                const maxs = active.map(g => Math.max(g.a, g.aMax)).filter(a => a >= 0);
                const aAvg = avgs.length ? avgs.reduce((s, x) => s + x, 0) / avgs.length : -1;
                const aMax = maxs.length ? Math.max(...maxs) : -1;
                await writers[level].writeGop(gop, win[0].t, we, frameCount, aAvg, aMax);
                lastEncoded[level] = win[0].t;
                did = true;
            }
        } else if (lastEncoded[level] !== undefined) {
            // The whole window is static: propagate a no-change record referencing the last
            // encoded thinned GOP (skipped if we have no reference yet).
            const n = win.reduce((s, g) => s + g.n, 0);
            await writers[level].writeNoChange(win[0].t, we, lastEncoded[level]!, n);
            did = true;
        }
        cursor[level] = we;
    }
    return did;
}

let running = false;
async function loop(): Promise<void> {
    if (running) return;
    running = true;
    try {
        for (let level = 1; level <= THIN_LEVELS; level++) {
            try { await buildLevel(level); } catch (e) { console.error(`[thin] L${level} failed:`, (e as Error).message); }
        }
    } finally {
        running = false;
        setTimeout(loop, PERIOD_MS);
    }
}

console.log(`[thin] worker started (levels 1..${THIN_LEVELS}, ${THIN_BITRATE / 1e6} Mbps re-encode)`);
loop();
