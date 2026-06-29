// Thinning worker (separate daemon — see docs/thinning.md). Builds the cascading
// thinned levels L1..L4. Each level-L GOP covers one 30^L-second window of the real
// timeline, played back in ~1s.
//
// SMART, ACTIVITY-PRESERVING thinning (not a cascade of keyframes): for each output
// window we draw frames straight from the ORIGINAL real-time footage (L0) whenever it
// still covers the window — so a high level is one re-encode away from the camera, not
// L generations of re-encode. If L0 has been aged out (retention) and a lower thinned
// level covers the window, we fall back to the lowest such level. The window is split
// into 30 slots; from each slot we keep the single HIGHEST per-frame-activity frame
// (decoding just those frames), so brief events survive all the way up the levels.
// Fully-static windows become a no-change record (no video bytes). Run via typenode.

import { spawn } from "child_process";
import { getTimezone } from "./timezone";
process.env.TZ = getTimezone();
import { THIN_LEVELS, THIN_BITRATE, levelGopSpanSec } from "./config";
import {
    GopEntry, LevelWriter, readLevelGops, readLevelGopAt, levelTimeBounds, ACT_SCALE, actToU16, enforceRetention,
} from "./storage";
import { AnnexBSplitter, splitFramedNals } from "./annexb";

const PERIOD_MS = 5000;            // how often we look for new windows to build
const WINDOWS_PER_PASS = 10;       // cap work per level per pass (rest picked up next tick)
const SLOTS = 30;                  // frames per thinned GOP (one per time slot)
const L0_MIN_COVERAGE = 0.5;       // use L0 directly while it covers at least this much of a window
const START_CODE = Buffer.from([0, 0, 0, 1]);
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);

const writers: LevelWriter[] = [];
const cursor: (number | null)[] = []; // next window-start (epoch ms) per level
const lastEncoded: (number | undefined)[] = []; // start time of the last encoded GOP per level (no-change ref)
for (let l = 0; l <= THIN_LEVELS; l++) { writers.push(new LevelWriter(l)); cursor.push(null); lastEncoded.push(undefined); }

// MJPEG byte-stream -> individual JPEG frames (ffmpeg image2pipe output).
function splitJpegs(buf: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let p = 0;
    while (true) {
        const soi = buf.indexOf(SOI, p);
        if (soi < 0) break;
        const eoi = buf.indexOf(EOI, soi + 2);
        if (eoi < 0) break;
        out.push(buf.subarray(soi, eoi + 2));
        p = eoi + 2;
    }
    return out;
}

// Annex-B byte-stream (start-code prefixed) of a stored GOP, for piping into ffmpeg.
function annexbOf(bytes: Buffer): Buffer {
    const parts: Buffer[] = [];
    for (const n of splitFramedNals(bytes)) { parts.push(START_CODE, n); }
    return Buffer.concat(parts);
}

// Decode specific frame indices from one source GOP to JPEGs, returned in the same
// order as `indices` (ascending). One ffmpeg decode per source GOP; `select` emits
// only the wanted frames.
function decodeFrames(level: number, g: GopEntry, indices: number[]): Promise<Buffer[]> {
    return new Promise(async resolve => {
        let annexb: Buffer;
        try { annexb = annexbOf(await readLevelGopAt(level, g)); } catch { return resolve([]); }
        const sel = indices.map(i => `eq(n\\,${i})`).join("+");
        const dec = spawn("ffmpeg", [
            "-hide_banner", "-loglevel", "error",
            "-f", "h264", "-i", "pipe:0",
            "-vf", `select='${sel}'`, "-vsync", "0",
            "-q:v", "2", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
        ], { stdio: ["pipe", "pipe", "ignore"] });
        const chunks: Buffer[] = [];
        dec.stdout?.on("data", (c: Buffer) => chunks.push(c));
        dec.on("close", () => resolve(splitJpegs(Buffer.concat(chunks))));
        dec.on("error", () => resolve([]));
        dec.stdin?.on("error", () => { /* */ });
        try { dec.stdin?.write(annexb); dec.stdin?.end(); } catch { resolve([]); }
    });
}

// Encode a sequence of JPEG frames into one H.264 GOP (hardware h264_v4l2m2m).
// Returns [sps, pps, slice...] and the slice count. No clock overlay — playback draws the
// timestamp client-side from each frame's stored wall time (same as L0).
function encodeGop(jpegs: Buffer[]): Promise<{ nals: Buffer[]; frameCount: number }> {
    return new Promise(resolve => {
        const enc = spawn("ffmpeg", [
            "-hide_banner", "-loglevel", "error",
            "-f", "mjpeg", "-i", "pipe:0",
            "-vf", "format=yuv420p",
            "-c:v", "h264_v4l2m2m", "-b:v", String(THIN_BITRATE), "-g", String(SLOTS),
            "-f", "h264", "pipe:1",
        ], { stdio: ["pipe", "pipe", "ignore"] });
        const split = new AnnexBSplitter();
        let sps: Buffer | undefined, pps: Buffer | undefined;
        const slices: Buffer[] = [];
        const onNal = (n: Buffer) => { const t = n[0] & 0x1f; if (t === 7) sps = n; else if (t === 8) pps = n; else if (t === 5 || t === 1) slices.push(n); };
        enc.stdout?.on("data", (c: Buffer) => { for (const n of split.push(c)) onNal(n); });
        enc.on("close", () => {
            for (const n of split.flush()) onNal(n);
            const nals: Buffer[] = [];
            if (sps) nals.push(sps);
            if (pps) nals.push(pps);
            nals.push(...slices);
            resolve({ nals, frameCount: slices.length });
        });
        enc.on("error", () => resolve({ nals: [], frameCount: 0 }));
        enc.stdin?.on("error", () => { /* */ });
        for (const j of jpegs) { try { enc.stdin?.write(j); } catch { /* */ } }
        try { enc.stdin?.end(); } catch { /* */ }
    });
}

// Fraction of [ws, we) covered by these GOPs (no-change GOPs count — they cover time too).
function coverageOf(gops: GopEntry[], ws: number, we: number): number {
    const span = we - ws;
    if (span <= 0) return 0;
    let c = 0;
    for (const g of gops) { const s = Math.max(g.t, ws), e = Math.min(g.e, we); if (e > s) c += e - s; }
    return c / span;
}

type Cand = { g: GopEntry; idx: number; wall: number; act: number };

// Build one thinned window [ws, we) for `level`.
async function buildWindow(level: number, ws: number, we: number): Promise<void> {
    // Pick the base level: prefer L0 (original footage). If L0 no longer covers enough of
    // the window, step up to the lowest thinned level that covers it (falling back to the
    // immediate source level, which is always present since we build bottom-up).
    let base = 0;
    let gops = await readLevelGops(0, ws, we);
    if (coverageOf(gops, ws, we) < L0_MIN_COVERAGE) {
        for (let b = 1; b < level; b++) {
            const gs = await readLevelGops(b, ws, we);
            if (coverageOf(gs, ws, we) >= 0.99 || b === level - 1) { base = b; gops = gs; break; }
        }
    }

    // Candidate frames = every real frame of the active (has-video) base GOPs.
    const cand: Cand[] = [];
    for (const g of gops) {
        if (g.l <= 0 || g.n <= 0) continue; // no-change / empty -> no decodable frame
        const fs = (g.e - g.t) / g.n;
        for (let j = 0; j < g.n; j++) cand.push({ g, idx: j, wall: g.t + j * fs, act: (g.acts[j] ?? 0) / ACT_SCALE });
    }
    if (!cand.length) { // wholly static window
        if (lastEncoded[level] !== undefined) await writers[level].writeNoChange(ws, we, lastEncoded[level]!, new Uint16Array(0));
        return;
    }

    // One frame per slot: the highest-activity frame whose time falls in that slot.
    const slot = (we - ws) / SLOTS;
    const picked: Cand[] = [];
    for (let s = 0; s < SLOTS; s++) {
        const a = ws + s * slot, b = a + slot;
        let best: Cand | null = null;
        for (const c of cand) { if (c.wall >= a && c.wall < b && (!best || c.act > best.act)) best = c; }
        if (best) picked.push(best);
    }
    if (!picked.length) picked.push(cand.reduce((m, c) => (c.act > m.act ? c : m), cand[0]));

    // Decode the picked frames (grouped by source GOP) and re-encode them in slot order.
    const groups = new Map<GopEntry, number[]>();
    for (const p of picked) { const arr = groups.get(p.g) ?? []; arr.push(p.idx); groups.set(p.g, arr); }
    const jpegByKey = new Map<string, Buffer>();
    for (const [g, idxs] of groups) {
        const uniq = [...new Set(idxs)].sort((a, b) => a - b);
        const jpegs = await decodeFrames(base, g, uniq);
        for (let k = 0; k < uniq.length; k++) if (jpegs[k]) jpegByKey.set(`${g.t}:${uniq[k]}`, jpegs[k]);
    }
    const jpegSeq: Buffer[] = [];
    const actsArr: number[] = [];
    for (const p of picked) { const jp = jpegByKey.get(`${p.g.t}:${p.idx}`); if (jp) { jpegSeq.push(jp); actsArr.push(actToU16(p.act)); } }
    if (!jpegSeq.length) {
        if (lastEncoded[level] !== undefined) await writers[level].writeNoChange(ws, we, lastEncoded[level]!, new Uint16Array(0));
        return;
    }

    const { nals, frameCount } = await encodeGop(jpegSeq);
    if (frameCount > 0) {
        const acts = new Uint16Array(frameCount);
        for (let i = 0; i < frameCount && i < actsArr.length; i++) acts[i] = actsArr[i];
        await writers[level].writeGop(nals, ws, we, frameCount, acts);
        lastEncoded[level] = ws;
    }
}

// Build any windows of `level` whose real-time span has fully elapsed.
async function buildLevel(level: number): Promise<boolean> {
    const span = levelGopSpanSec(level) * 1000;
    const realLatest = (await levelTimeBounds(0)).latest; // L0 end = how far the timeline has progressed
    if (!realLatest) return false;

    if (cursor[level] == null) {
        const mine = await levelTimeBounds(level);
        const earliest = (await levelTimeBounds(0)).earliest || realLatest;
        cursor[level] = mine.latest ? Math.floor(mine.latest / span) * span : Math.floor(earliest / span) * span;
    }
    const from = cursor[level]!;
    if (from + span > realLatest) return false; // current window not complete yet

    const passTo = Math.min(Math.floor(realLatest / span) * span, from + span * WINDOWS_PER_PASS);
    let did = false;
    for (let ws = from; ws + span <= realLatest && ws < passTo; ws += span) {
        await buildWindow(level, ws, ws + span);
        cursor[level] = ws + span;
        did = true;
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

// Disk retention lives here now (the Rust recorder doesn't manage it): enforce each level's
// byte budget periodically, deleting the oldest buckets first.
setInterval(async () => {
    try { const r = await enforceRetention(); if (r.deleted.length) console.log(`[thin] retention: deleted ${r.deleted.length} pair(s), now ${(r.totalBytes / 1e9).toFixed(2)} GB`); }
    catch (e) { console.error("[thin] retention failed:", (e as Error).message); }
}, 60_000);

console.log(`[thin] worker started (levels 1..${THIN_LEVELS}, smart-from-L0, ${THIN_BITRATE / 1e6} Mbps re-encode)`);
loop();
