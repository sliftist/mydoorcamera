// On-disk video store (v3). Per capture session + hour, two files stream side by
// side into the day's directory:
//   YYYY/MM/DD/<HH>.<sessionId>.data   length-prefixed NAL bytes (GOP after GOP)
//   YYYY/MM/DD/<HH>.<sessionId>.idx    BINARY index, one framed record per GOP
//
// Index record framing (all little-endian):
//   [u32 len][ f64 × (len/8) ][u32 len]
// The length is written as BOTH a prefix and a suffix, so a partially-written
// trailing record (prefix present, body/suffix not) or a corrupted record
// (prefix != suffix) is detected on read — we stop there and ignore everything
// after. Fields are plain float64 (no bit-packing): [t, e, o, l, n, activity].
// activity is -1 until a background worker computes it (so it can be backfilled
// in place without touching the framing).
//
// A restart makes a new sessionId, so an hour can have several file pairs. On
// read we combine them ordered by sessionId, RESERVING each GOP's [t, next-t]
// footprint; a later session overlapping a reserved range is dropped + warned
// (interlaced data) and reported as a "bad range".

import * as fs from "fs";
import * as path from "path";
import { DATA_DIR, RETENTION_BYTES } from "./config";
import { frameNal } from "./annexb";

export type Range = { start: number; end: number };
export type GopEntry = { t: number; e: number; f: string; o: number; l: number; n: number; a: number };
export type HourIndex = { gops: GopEntry[]; badRanges: Range[] };
export type DayCoverage = { dayStartMs: number; dayEndMs: number; ranges: Range[]; badRanges: Range[]; activity: number[] };

const FIELD_COUNT = 6;                 // t, e, o, l, n, activity
const REC_BYTES = 4 + FIELD_COUNT * 8 + 4;
const ACTIVITY_FIELD = 5;              // index of the activity float within a record
export const ACTIVITY_BYTE_OFFSET = 4 + ACTIVITY_FIELD * 8; // byte offset of activity within a record
const ACT_BUCKETS = 1440;              // per-minute activity buckets for the day chart

function pad2(n: number): string { return String(n).padStart(2, "0"); }
function dayPartsOf(ms: number): string[] { const d = new Date(ms); return [String(d.getFullYear()), pad2(d.getMonth() + 1), pad2(d.getDate())]; }
function hourOf(ms: number): string { return pad2(new Date(ms).getHours()); }

function encodeRecord(t: number, e: number, o: number, l: number, n: number, a: number): Buffer {
    const buf = Buffer.allocUnsafe(REC_BYTES);
    const body = FIELD_COUNT * 8;
    buf.writeUInt32LE(body, 0);
    const vals = [t, e, o, l, n, a];
    for (let i = 0; i < FIELD_COUNT; i++) buf.writeDoubleLE(vals[i], 4 + i * 8);
    buf.writeUInt32LE(body, 4 + body);
    return buf;
}

// Parse framed records from `buf`. Returns each record's fields, the byte offset
// of each record's start (within buf), and how many bytes were validly consumed.
function decodeRecords(buf: Buffer, dataFile: string): { gops: GopEntry[]; starts: number[]; consumed: number } {
    const gops: GopEntry[] = [];
    const starts: number[] = [];
    let p = 0;
    while (p + 4 <= buf.length) {
        const len = buf.readUInt32LE(p);
        if (len <= 0 || len % 8 !== 0 || p + 4 + len + 4 > buf.length) break; // partial / not yet fully written
        if (buf.readUInt32LE(p + 4 + len) !== len) break;                     // corruption: prefix != suffix -> stop
        const v: number[] = [];
        for (let i = 0; i < len / 8; i++) v.push(buf.readDoubleLE(p + 4 + i * 8));
        gops.push({ t: v[0], e: v[1], f: dataFile, o: v[2], l: v[3], n: v[4], a: v.length > 5 ? v[5] : -1 });
        starts.push(p);
        p += 4 + len + 4;
    }
    return { gops, starts, consumed: p };
}

function mergeRanges(rs: Range[], joinMs = 0): Range[] {
    if (!rs.length) return [];
    const s = [...rs].sort((a, b) => a.start - b.start);
    const out: Range[] = [{ ...s[0] }];
    for (let i = 1; i < s.length; i++) {
        const last = out[out.length - 1];
        if (s[i].start <= last.end + joinMs) last.end = Math.max(last.end, s[i].end);
        else out.push({ ...s[i] });
    }
    return out;
}

const SESSION = Date.now();

export class StorageWriter {
    private dataDir = "";
    private dataHour = "";
    private dataPath = "";
    private offset = 0;

    private ensureDataTarget(ms: number): void {
        const dir = path.join(DATA_DIR, ...dayPartsOf(ms));
        const hh = hourOf(ms);
        if (dir === this.dataDir && hh === this.dataHour) return;
        fs.mkdirSync(dir, { recursive: true });
        this.dataDir = dir; this.dataHour = hh;
        this.dataPath = path.join(dir, `${hh}.${SESSION}.data`);
        try { this.offset = fs.statSync(this.dataPath).size; } catch { this.offset = 0; }
    }

    // Write the GOP bytes (data first), then the framed index record. activity
    // starts at -1; the activity worker backfills it in place later.
    writeGop(nals: Buffer[], timeMs: number, frameCount: number, activity = -1): void {
        this.ensureDataTarget(timeMs);
        const body = Buffer.concat(nals.map(frameNal));
        fs.appendFileSync(this.dataPath, body);
        const o = this.offset;
        this.offset += body.length;
        const e = timeMs + Math.round((frameCount / 30) * 1000);
        const idxPath = path.join(DATA_DIR, ...dayPartsOf(timeMs), `${hourOf(timeMs)}.${SESSION}.idx`);
        fs.appendFileSync(idxPath, encodeRecord(timeMs, e, o, body.length, frameCount, activity));
    }
}

// ---- read side ----

export function listChildren(parts: string[]): string[] {
    try {
        return fs.readdirSync(path.join(DATA_DIR, ...parts), { withFileTypes: true })
            .filter(e => e.isDirectory()).map(e => e.name).sort();
    } catch { return []; }
}

export function getAvailableDays(): string[] {
    const out: string[] = [];
    for (const y of listChildren([]))
        for (const mo of listChildren([y]))
            for (const d of listChildren([y, mo])) out.push(`${y}/${mo}/${d}`);
    return out;
}

function readIdxFile(parts: string[], idxFile: string): GopEntry[] {
    try {
        const buf = fs.readFileSync(path.join(DATA_DIR, ...parts, idxFile));
        return decodeRecords(buf, idxFile.slice(0, -4) + ".data").gops;
    } catch { return []; }
}

export function combineHour(parts: string[]): HourIndex {
    const [y, mo, d, hh] = parts;
    const dir = path.join(DATA_DIR, y, mo, d);
    let files: string[];
    try { files = fs.readdirSync(dir); } catch { return { gops: [], badRanges: [] }; }
    const idxFiles = files
        .filter(f => f.startsWith(hh + ".") && f.endsWith(".idx"))
        .map(f => ({ f, session: Number(f.split(".")[1]) || 0 }))
        .sort((a, b) => a.session - b.session);

    const reserved: Range[] = [];
    const gops: GopEntry[] = [];
    const bad: Range[] = [];
    const overlaps = (s: number, e: number) => reserved.some(r => s < r.end && e > r.start);
    const reserve = (s: number, e: number) => {
        const last = reserved[reserved.length - 1];
        if (last && s <= last.end && s >= last.start) last.end = Math.max(last.end, e);
        else reserved.push({ start: s, end: e });
    };

    for (const { f } of idxFiles) {
        const recs = readIdxFile([y, mo, d], f);
        for (let i = 0; i < recs.length; i++) {
            const rec = recs[i];
            const footEnd = i + 1 < recs.length ? recs[i + 1].t : rec.e; // real coverage = up to next keyframe
            if (overlaps(rec.t, footEnd)) { bad.push({ start: rec.t, end: footEnd }); continue; }
            reserve(rec.t, footEnd);
            gops.push(rec);
        }
    }
    gops.sort((a, b) => a.t - b.t);
    const badRanges = mergeRanges(bad);
    if (badRanges.length) console.warn(`[storage] interlaced/overlapping data in ${y}/${mo}/${d} ${hh}h: ${bad.length} GOP(s) ignored`);
    return { gops, badRanges };
}

export function getDayCoverage(parts: string[]): DayCoverage {
    const [y, mo, d] = parts;
    const dayStartMs = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0).getTime();
    const dayEndMs = dayStartMs + 24 * 3600 * 1000;
    const good: Range[] = [];
    const bad: Range[] = [];
    const activity = new Array(ACT_BUCKETS).fill(0);
    for (let h = 0; h < 24; h++) {
        const { gops, badRanges } = combineHour([y, mo, d, pad2(h)]);
        for (const g of gops) {
            good.push({ start: g.t, end: g.e });
            if (g.a >= 0) {
                const b = Math.min(ACT_BUCKETS - 1, Math.max(0, Math.floor((g.t - dayStartMs) / 60000)));
                if (g.a > activity[b]) activity[b] = g.a;
            }
        }
        bad.push(...badRanges);
    }
    return { dayStartMs, dayEndMs, ranges: mergeRanges(good, 2500), badRanges: mergeRanges(bad), activity };
}

export function readGopBytes(parts: string[], file: string, off: number, len: number): Buffer {
    const fd = fs.openSync(path.join(DATA_DIR, ...parts, file), "r");
    try { const b = Buffer.allocUnsafe(len); fs.readSync(fd, b, 0, len, off); return b; }
    finally { fs.closeSync(fd); }
}

// ---- live streaming helpers ----

export function latestIdxFile(parts: string[]): string | undefined {
    const dir = path.join(DATA_DIR, ...parts);
    let files: string[]; try { files = fs.readdirSync(dir); } catch { return undefined; }
    let best: string | undefined, bestM = -1;
    for (const f of files) {
        if (!f.endsWith(".idx")) continue;
        try { const m = fs.statSync(path.join(dir, f)).mtimeMs; if (m > bestM) { bestM = m; best = f; } } catch { /* */ }
    }
    return best;
}

// Read complete framed records after `fromByte`; framing detects partial writes.
export function readIdxIncremental(parts: string[], idxFile: string, fromByte: number): { records: GopEntry[]; ends: number[]; nextByte: number } {
    const p = path.join(DATA_DIR, ...parts, idxFile);
    let size: number; try { size = fs.statSync(p).size; } catch { return { records: [], ends: [], nextByte: fromByte }; }
    if (size <= fromByte) return { records: [], ends: [], nextByte: fromByte };
    const fd = fs.openSync(p, "r");
    try {
        const buf = Buffer.allocUnsafe(size - fromByte);
        fs.readSync(fd, buf, 0, size - fromByte, fromByte);
        const { gops, starts, consumed } = decodeRecords(buf, idxFile.slice(0, -4) + ".data");
        const ends = starts.map((s, i) => fromByte + (i + 1 < starts.length ? starts[i + 1] : consumed));
        return { records: gops, ends, nextByte: fromByte + consumed };
    } finally { fs.closeSync(fd); }
}

// ---- activity worker helpers ----

// Backfill one record's activity float in place (fixed-size field; framing untouched).
export function writeActivity(parts: string[], idxFile: string, recordStart: number, activity: number): void {
    const fd = fs.openSync(path.join(DATA_DIR, ...parts, idxFile), "r+");
    try { const b = Buffer.allocUnsafe(8); b.writeDoubleLE(activity, 0); fs.writeSync(fd, b, 0, 8, recordStart + ACTIVITY_BYTE_OFFSET); }
    finally { fs.closeSync(fd); }
}

// Oldest records still needing activity (a === -1), in time order, bounded.
export function findPendingActivity(limit: number): { parts: string[]; idxFile: string; start: number; gop: GopEntry }[] {
    const out: { parts: string[]; idxFile: string; start: number; gop: GopEntry }[] = [];
    for (const y of listChildren([])) for (const mo of listChildren([y])) for (const d of listChildren([y, mo])) {
        const parts = [y, mo, d];
        let files: string[]; try { files = fs.readdirSync(path.join(DATA_DIR, ...parts)); } catch { continue; }
        for (const f of files.filter(x => x.endsWith(".idx")).sort()) {
            const buf = (() => { try { return fs.readFileSync(path.join(DATA_DIR, ...parts, f)); } catch { return null; } })();
            if (!buf) continue;
            const { gops, starts } = decodeRecords(buf, f.slice(0, -4) + ".data");
            for (let i = 0; i < gops.length; i++) {
                if (gops[i].a === -1) { out.push({ parts, idxFile: f, start: starts[i], gop: gops[i] }); if (out.length >= limit) return out; }
            }
        }
    }
    return out;
}

export function dataReady(parts: string[], dataFile: string, o: number, l: number): boolean {
    try { return fs.statSync(path.join(DATA_DIR, ...parts, dataFile)).size >= o + l; } catch { return false; }
}

export function daySignature(parts: string[]): string {
    const dir = path.join(DATA_DIR, ...parts);
    let files: string[]; try { files = fs.readdirSync(dir); } catch { return ""; }
    let sig = "";
    for (const f of files.sort()) {
        if (!f.endsWith(".idx")) continue;
        try { const s = fs.statSync(path.join(dir, f)); sig += `${f}:${s.size}:${Math.round(s.mtimeMs)};`; } catch { /* */ }
    }
    return sig;
}

export function enforceRetention(): { deleted: string[]; totalBytes: number } {
    const items: { data: string; idx: string; key: string; bytes: number }[] = [];
    for (const y of listChildren([])) for (const mo of listChildren([y])) for (const d of listChildren([y, mo])) {
        const dir = path.join(DATA_DIR, y, mo, d);
        let files: string[]; try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith(".data")) continue;
            let bytes = 0; try { bytes = fs.statSync(path.join(dir, f)).size; } catch { /* */ }
            items.push({ data: path.join(dir, f), idx: path.join(dir, f.slice(0, -5) + ".idx"), key: `${y}/${mo}/${d}/${f}`, bytes });
        }
    }
    let total = items.reduce((s, i) => s + i.bytes, 0);
    items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const deleted: string[] = [];
    for (const it of items) {
        if (total <= RETENTION_BYTES) break;
        try { fs.rmSync(it.data, { force: true }); fs.rmSync(it.idx, { force: true }); } catch { /* */ }
        total -= it.bytes; deleted.push(it.key);
    }
    for (const y of listChildren([])) for (const mo of listChildren([y])) for (const d of listChildren([y, mo])) {
        const dir = path.join(DATA_DIR, y, mo, d);
        try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* */ }
    }
    return { deleted, totalBytes: total };
}
