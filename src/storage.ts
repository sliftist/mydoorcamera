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
//
// All disk I/O here is ASYNC (fs.promises) so the HTTPS/WSS server never blocks
// the event loop on a read while serving other clients. Writers serialize their
// appends through a per-writer promise chain so offsets stay consistent.

import { promises as fsp } from "fs";
import type { Dirent } from "fs";
import * as path from "path";
import { DATA_DIR, THIN_DIR, DISK_RESERVE_BYTES, MIN_TOTAL_BUDGET_BYTES, LEVEL_COUNT, levelGopSpanSec } from "./config";
import { frameNal } from "./annexb";

export type Range = { start: number; end: number };
// a = average activity (L0: the single value); aMax = max activity (L0: == a).
// Per-frame activity is stored as uint16 (act/65535). a/aMax are the derived max over the
// frames (kept for existing consumers). noChange (l===0) => no video bytes; ref = the GOP whose
// last frame the static span repeats (carried in the o field).
export type GopEntry = { t: number; e: number; f: string; o: number; l: number; n: number; a: number; aMax: number; acts: Uint16Array; noChange: boolean; ref: number };
export const ACT_SCALE = 65535;
export const actToU16 = (a: number): number => Math.max(0, Math.min(ACT_SCALE, Math.round((a > 0 ? a : 0) * ACT_SCALE)));
export type HourIndex = { gops: GopEntry[]; badRanges: Range[] };
export type DayCoverage = { dayStartMs: number; dayEndMs: number; ranges: Range[]; badRanges: Range[]; activity: number[] };
export type LevelCoverage = { fromMs: number; toMs: number; ranges: Range[]; badRanges: Range[]; activity: number[] };
export type LevelInfo = {
    level: number; timePerSec: number; gopSpanSec: number;
    budgetBytes: number; usedBytes: number;
    earliestMs: number; latestMs: number;   // 0/0 when empty
};

const ACT_BUCKETS = 1440;              // per-minute activity buckets for the day chart

function pad2(n: number): string { return String(n).padStart(2, "0"); }
function dayPartsOf(ms: number): string[] { const d = new Date(ms); return [String(d.getFullYear()), pad2(d.getMonth() + 1), pad2(d.getDate())]; }
function hourOf(ms: number): string { return pad2(new Date(ms).getHours()); }

async function readdirSafe(dir: string): Promise<string[]> { try { return await fsp.readdir(dir); } catch { return []; } }
async function readdirEnts(dir: string): Promise<Dirent[]> { try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; } }
async function sizeOf(p: string): Promise<number> { try { return (await fsp.stat(p)).size; } catch { return -1; } }

// ---- level-aware paths ----
// L0 lives in DATA_DIR; thinned levels under THIN_DIR/L<n>. The file/folder
// bucket coarsens one calendar step per level so each file holds a healthy batch
// of GOPs (see docs/thinning.md): L0=hour, L1=day, L2=month, L3/L4=year.
export function levelRoot(level: number): string { return level === 0 ? DATA_DIR : path.join(THIN_DIR, "L" + level); }

// Directory (relative to the level root) and file stem for a timestamp.
function bucketOf(level: number, ms: number): { dir: string[]; stem: string } {
    const d = new Date(ms);
    const Y = String(d.getFullYear()), MM = pad2(d.getMonth() + 1), DD = pad2(d.getDate()), HH = pad2(d.getHours());
    switch (level) {
        // Folder granularity caps at year, file granularity caps at month. So the
        // navigable period scales: L0 = a day, L1 = a month, L2+ = a year.
        case 0: return { dir: [Y, MM, DD], stem: HH };  // folder=day,   file=hour
        case 1: return { dir: [Y, MM], stem: DD };      // folder=month, file=day
        default: return { dir: [Y], stem: MM };         // folder=year,  file=month (L2, L3, L4)
    }
}

// Recursively find every "<stem>.<session>.idx" under a level root, returning
// each unique bucket (dir relative to root + stem). Levels are small (few files).
async function listLevelBuckets(level: number): Promise<{ dir: string[]; stem: string }[]> {
    const root = levelRoot(level);
    const seen = new Set<string>();
    const out: { dir: string[]; stem: string }[] = [];
    const walk = async (rel: string[]): Promise<void> => {
        for (const e of await readdirEnts(path.join(root, ...rel))) {
            if (e.isDirectory()) await walk([...rel, e.name]);
            else if (e.name.endsWith(".idx")) {
                const stem = e.name.split(".")[0];
                const key = rel.join("/") + "|" + stem;
                if (!seen.has(key)) { seen.add(key); out.push({ dir: rel, stem }); }
            }
        }
    };
    await walk([]);
    return out;
}

// Framed record: [u32 len][f64 t,e,o,l,n][u16 act_0..act_{n-1}][u32 len], len = 40 + 2*n.
// Per-frame activity is uint16 (act*65535). l===0 marks a no-change GOP (no video bytes), with
// the o field carrying refT (the GOP whose last frame the static span repeats).
function encodeRecord(t: number, e: number, o: number, l: number, n: number, acts: Uint16Array): Buffer {
    const body = 40 + acts.length * 2;
    const buf = Buffer.allocUnsafe(4 + body + 4);
    buf.writeUInt32LE(body, 0);
    buf.writeDoubleLE(t, 4); buf.writeDoubleLE(e, 12); buf.writeDoubleLE(o, 20); buf.writeDoubleLE(l, 28); buf.writeDoubleLE(n, 36);
    for (let i = 0; i < acts.length; i++) buf.writeUInt16LE(acts[i], 44 + i * 2);
    buf.writeUInt32LE(body, 4 + body);
    return buf;
}

// Parse framed records from `buf`. Returns each record's GopEntry, the byte offset of each
// record's start, and how many bytes were validly consumed.
function decodeRecords(buf: Buffer, dataFile: string): { gops: GopEntry[]; starts: number[]; consumed: number } {
    const gops: GopEntry[] = [];
    const starts: number[] = [];
    let p = 0;
    while (p + 4 <= buf.length) {
        const len = buf.readUInt32LE(p);
        if (len < 40 || (len - 40) % 2 !== 0 || p + 4 + len + 4 > buf.length) break; // partial / not yet fully written
        if (buf.readUInt32LE(p + 4 + len) !== len) break;                            // corruption: prefix != suffix -> stop
        const t = buf.readDoubleLE(p + 4), e = buf.readDoubleLE(p + 12), o = buf.readDoubleLE(p + 20), l = buf.readDoubleLE(p + 28), n = buf.readDoubleLE(p + 36);
        const na = (len - 40) / 2;
        const acts = new Uint16Array(na);
        let mx = 0;
        for (let i = 0; i < na; i++) { const v = buf.readUInt16LE(p + 44 + i * 2); acts[i] = v; if (v > mx) mx = v; }
        const aMax = mx / ACT_SCALE;
        gops.push({ t, e, f: dataFile, o, l, n, a: aMax, aMax, acts, noChange: l === 0, ref: l === 0 ? o : 0 });
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

// Serializes GOP appends for the unthinned root (L0). writeGop returns a promise
// that resolves when this GOP is on disk; callers may fire-and-forget (the chain
// keeps offsets consistent) or await for back-pressure.
export class StorageWriter {
    private dataDir = "";
    private dataHour = "";
    private dataPath = "";
    private offset = 0;
    private tail: Promise<void> = Promise.resolve();

    private async ensureDataTarget(ms: number): Promise<void> {
        const dir = path.join(DATA_DIR, ...dayPartsOf(ms));
        const hh = hourOf(ms);
        if (dir === this.dataDir && hh === this.dataHour) return;
        await fsp.mkdir(dir, { recursive: true });
        this.dataDir = dir; this.dataHour = hh;
        this.dataPath = path.join(dir, `${hh}.${SESSION}.data`);
        const sz = await sizeOf(this.dataPath);
        this.offset = sz >= 0 ? sz : 0;
    }

    // Write the GOP bytes (data first), then the framed index record with per-frame activity.
    writeGop(nals: Buffer[], timeMs: number, frameCount: number, acts?: Uint16Array): Promise<void> {
        const run = async (): Promise<void> => {
            await this.ensureDataTarget(timeMs);
            const body = Buffer.concat(nals.map(frameNal));
            await fsp.appendFile(this.dataPath, body);
            const o = this.offset;
            this.offset += body.length;
            const e = timeMs + Math.round((frameCount / 30) * 1000);
            const a = acts && acts.length === frameCount ? acts : new Uint16Array(frameCount);
            const idxPath = path.join(DATA_DIR, ...dayPartsOf(timeMs), `${hourOf(timeMs)}.${SESSION}.idx`);
            await fsp.appendFile(idxPath, encodeRecord(timeMs, e, o, body.length, frameCount, a));
        };
        this.tail = this.tail.then(run).catch(err => { console.error("[storage] writeGop failed:", (err as Error)?.message); });
        return this.tail;
    }

    // A static GOP: index record only (no video bytes). `l` = 0 is the sentinel; `o` carries
    // `refT` (the GOP whose last frame this span repeats). Per-frame activity is still stored.
    writeNoChange(timeMs: number, refT: number, acts: Uint16Array): Promise<void> {
        const run = async (): Promise<void> => {
            const n = acts.length;
            const e = timeMs + Math.round((n / 30) * 1000);
            const idxPath = path.join(DATA_DIR, ...dayPartsOf(timeMs), `${hourOf(timeMs)}.${SESSION}.idx`);
            await fsp.appendFile(idxPath, encodeRecord(timeMs, e, refT, 0, n, acts));
        };
        this.tail = this.tail.then(run).catch(err => { console.error("[storage] writeNoChange failed:", (err as Error)?.message); });
        return this.tail;
    }
}

// ---- read side ----

export async function listChildren(parts: string[]): Promise<string[]> {
    return (await readdirEnts(path.join(DATA_DIR, ...parts))).filter(e => e.isDirectory()).map(e => e.name).sort();
}

export async function getAvailableDays(): Promise<string[]> {
    const out: string[] = [];
    for (const y of await listChildren([]))
        for (const mo of await listChildren([y]))
            for (const d of await listChildren([y, mo])) out.push(`${y}/${mo}/${d}`);
    return out;
}

// Combine all sessions of one bucket (a level's file group: same stem, different
// sessions) into a single ordered GOP list, RESERVING each GOP's [t, next-t]
// footprint and dropping overlapping ("interlaced") data as bad ranges.
export async function combineBucket(level: number, dir: string[], stem: string): Promise<HourIndex> {
    const absDir = path.join(levelRoot(level), ...dir);
    const idxFiles = (await readdirSafe(absDir))
        .filter(f => f.startsWith(stem + ".") && f.endsWith(".idx"))
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
        let recs: GopEntry[];
        try { recs = decodeRecords(await fsp.readFile(path.join(absDir, f)), f.slice(0, -4) + ".data").gops; }
        catch { recs = []; }
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
    if (badRanges.length) console.warn(`[storage] interlaced/overlapping data in L${level} ${dir.join("/")}/${stem}: ${bad.length} GOP(s) ignored`);
    return { gops, badRanges };
}

export function combineHour(parts: string[]): Promise<HourIndex> {
    const [y, mo, d, hh] = parts;
    return combineBucket(0, [y, mo, d], hh);
}

// All GOP records of a level overlapping [fromMs, toMs), time-ordered.
export async function readLevelGops(level: number, fromMs: number, toMs: number): Promise<GopEntry[]> {
    const buckets = await listLevelBuckets(level);
    const perBucket = await Promise.all(buckets.map(b => combineBucket(level, b.dir, b.stem)));
    const out: GopEntry[] = [];
    for (const { gops } of perBucket) for (const g of gops) if (g.e > fromMs && g.t < toMs) out.push(g);
    out.sort((a, b) => a.t - b.t);
    return out;
}

// Coverage + activity for a level across an arbitrary span (drives the trackbar
// at any thinning level). Activity is the per-bucket max of aMax. Ranges are
// joined across gaps up to ~1.5 GOPs so contiguous coverage reads as one band.
// Time span (local) of a bucket, parsed from its dir + stem.
function bucketTimeRange(level: number, dir: string[], stem: string): { start: number; end: number } {
    const N = (s: string) => Number(s);
    if (level === 0) { const [Y, MM, DD] = dir.map(N), HH = N(stem); return { start: new Date(Y, MM - 1, DD, HH).getTime(), end: new Date(Y, MM - 1, DD, HH + 1).getTime() }; }
    if (level === 1) { const [Y, MM] = dir.map(N), DD = N(stem); return { start: new Date(Y, MM - 1, DD).getTime(), end: new Date(Y, MM - 1, DD + 1).getTime() }; }
    const [Y] = dir.map(N), MM = N(stem); return { start: new Date(Y, MM - 1, 1).getTime(), end: new Date(Y, MM, 1).getTime() }; // L2+: month file
}

// The raw on-disk index bytes for every bucket overlapping [fromMs, toMs),
// concatenated. Sent to the client verbatim (no processing) — it parses the same
// framed records to learn what data exists, frame counts, and per-GOP activity.
export async function getRawIndex(level: number, fromMs: number, toMs: number): Promise<Buffer> {
    const root = levelRoot(level);
    const parts: Buffer[] = [];
    for (const b of await listLevelBuckets(level)) {
        const r = bucketTimeRange(level, b.dir, b.stem);
        if (r.end <= fromMs || r.start >= toMs) continue;
        const absDir = path.join(root, ...b.dir);
        for (const f of (await readdirSafe(absDir)).filter(x => x.startsWith(b.stem + ".") && x.endsWith(".idx")).sort()) {
            try { parts.push(await fsp.readFile(path.join(absDir, f))); } catch { /* */ }
        }
    }
    return Buffer.concat(parts);
}

export async function getLevelCoverage(level: number, fromMs: number, toMs: number, buckets = 1440): Promise<LevelCoverage> {
    const gops = await readLevelGops(level, fromMs, toMs);
    const span = Math.max(1, toMs - fromMs);
    const good: Range[] = [];
    const activity = new Array(buckets).fill(0);
    for (const g of gops) {
        good.push({ start: g.t, end: g.e });
        const act = g.aMax >= 0 ? g.aMax : g.a;
        if (act >= 0) {
            const b = Math.min(buckets - 1, Math.max(0, Math.floor((g.t - fromMs) / span * buckets)));
            if (act > activity[b]) activity[b] = act;
        }
    }
    return { fromMs, toMs, ranges: mergeRanges(good, levelGopSpanSec(level) * 1000 * 1.5), badRanges: [], activity };
}

export async function readLevelGopBytes(level: number, dir: string[], file: string, off: number, len: number): Promise<Buffer> {
    const fh = await fsp.open(path.join(levelRoot(level), ...dir, file), "r");
    try { const b = Buffer.allocUnsafe(len); await fh.read(b, 0, len, off); return b; }
    finally { await fh.close(); }
}

// Read a GOP's bytes given only its timestamp (the bucket dir is derived from t,
// since the writer buckets every GOP by its t). Used by the thin worker + server.
export function readLevelGopData(level: number, t: number, file: string, off: number, len: number): Promise<Buffer> {
    return readLevelGopBytes(level, bucketOf(level, t).dir, file, off, len);
}
export function readLevelGopAt(level: number, g: GopEntry): Promise<Buffer> {
    return readLevelGopData(level, g.t, g.f, g.o, g.l);
}

// Bytes of the GOP active at wall time `t` for a level (the GOP with g.t <= t).
// Bucket/hour-scoped (cheap) so it can back per-thumbnail fetches from the client.
export async function getGopBytesAt(level: number, t: number): Promise<Buffer> {
    const { dir, stem } = bucketOf(level, t);
    const { gops } = await combineBucket(level, dir, stem);
    let g: GopEntry | undefined;
    for (const x of gops) { if (x.t <= t) g = x; else break; }
    if (!g && gops.length) g = gops[0];
    return g ? readLevelGopAt(level, g) : Buffer.alloc(0);
}

export async function getDayCoverage(parts: string[]): Promise<DayCoverage> {
    const [y, mo, d] = parts;
    const dayStartMs = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0).getTime();
    const dayEndMs = dayStartMs + 24 * 3600 * 1000;
    const hours = await Promise.all(Array.from({ length: 24 }, (_, h) => combineHour([y, mo, d, pad2(h)])));
    const good: Range[] = [];
    const bad: Range[] = [];
    const activity = new Array(ACT_BUCKETS).fill(0);
    for (const { gops, badRanges } of hours) {
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

export async function readGopBytes(parts: string[], file: string, off: number, len: number): Promise<Buffer> {
    const fh = await fsp.open(path.join(DATA_DIR, ...parts, file), "r");
    try { const b = Buffer.allocUnsafe(len); await fh.read(b, 0, len, off); return b; }
    finally { await fh.close(); }
}

// ---- live streaming helpers ----

export async function latestIdxFile(parts: string[]): Promise<string | undefined> {
    const dir = path.join(DATA_DIR, ...parts);
    let best: string | undefined, bestM = -1;
    for (const f of await readdirSafe(dir)) {
        if (!f.endsWith(".idx")) continue;
        try { const m = (await fsp.stat(path.join(dir, f))).mtimeMs; if (m > bestM) { bestM = m; best = f; } } catch { /* */ }
    }
    return best;
}

// Read complete framed records after `fromByte`; framing detects partial writes.
export async function readIdxIncremental(parts: string[], idxFile: string, fromByte: number): Promise<{ records: GopEntry[]; ends: number[]; nextByte: number }> {
    const p = path.join(DATA_DIR, ...parts, idxFile);
    const size = await sizeOf(p);
    if (size < 0 || size <= fromByte) return { records: [], ends: [], nextByte: fromByte };
    const fh = await fsp.open(p, "r");
    try {
        const buf = Buffer.allocUnsafe(size - fromByte);
        await fh.read(buf, 0, size - fromByte, fromByte);
        const { gops, starts, consumed } = decodeRecords(buf, idxFile.slice(0, -4) + ".data");
        const ends = starts.map((s, i) => fromByte + (i + 1 < starts.length ? starts[i + 1] : consumed));
        return { records: gops, ends, nextByte: fromByte + consumed };
    } finally { await fh.close(); }
}

export async function dataReady(parts: string[], dataFile: string, o: number, l: number): Promise<boolean> {
    return (await sizeOf(path.join(DATA_DIR, ...parts, dataFile))) >= o + l;
}

export async function daySignature(parts: string[]): Promise<string> {
    const dir = path.join(DATA_DIR, ...parts);
    let sig = "";
    for (const f of (await readdirSafe(dir)).sort()) {
        if (!f.endsWith(".idx")) continue;
        try { const s = await fsp.stat(path.join(dir, f)); sig += `${f}:${s.size}:${Math.round(s.mtimeMs)};`; } catch { /* */ }
    }
    return sig;
}

// ---- thinned-level writing ----

// Writes re-encoded thinned GOPs for one level. Same on-disk shape as L0, but
// level-bucketed paths and 7-field records ([t,e,o,l,n,aAvg,aMax]). Appends are
// serialized through a promise chain so offsets stay consistent.
export class LevelWriter {
    private session = Date.now();
    private curKey = "";
    private dataPath = "";
    private idxPath = "";
    private offset = 0;
    private tail: Promise<void> = Promise.resolve();

    constructor(private level: number) {}

    private async ensure(ms: number): Promise<void> {
        const { dir, stem } = bucketOf(this.level, ms);
        const absDir = path.join(levelRoot(this.level), ...dir);
        const key = absDir + "|" + stem;
        if (key !== this.curKey || !this.dataPath) {
            this.curKey = key;
            this.dataPath = path.join(absDir, `${stem}.${this.session}.data`);
            this.idxPath = path.join(absDir, `${stem}.${this.session}.idx`);
            const sz = await sizeOf(this.dataPath);
            this.offset = sz >= 0 ? sz : 0;
        }
        await fsp.mkdir(absDir, { recursive: true }); // ensure the dir exists every time (cheap; survives a wipe)
    }

    writeGop(nals: Buffer[], t: number, e: number, frameCount: number, acts?: Uint16Array): Promise<void> {
        const run = async (): Promise<void> => {
            await this.ensure(t);
            const body = Buffer.concat(nals.map(frameNal));
            await fsp.appendFile(this.dataPath, body);
            const o = this.offset; this.offset += body.length;
            const a = acts && acts.length === frameCount ? acts : new Uint16Array(frameCount);
            await fsp.appendFile(this.idxPath, encodeRecord(t, e, o, body.length, frameCount, a));
        };
        this.tail = this.tail.then(run).catch(err => { console.error(`[storage] L${this.level} writeGop failed:`, (err as Error)?.message); });
        return this.tail;
    }

    // No-change (static) thinned GOP: index record only (l=0 sentinel, o=refT), no video bytes.
    writeNoChange(t: number, e: number, refT: number, acts: Uint16Array): Promise<void> {
        const run = async (): Promise<void> => {
            await this.ensure(t);
            await fsp.appendFile(this.idxPath, encodeRecord(t, e, refT, 0, acts.length, acts));
        };
        this.tail = this.tail.then(run).catch(err => { console.error(`[storage] L${this.level} writeNoChange failed:`, (err as Error)?.message); });
        return this.tail;
    }
}

// ---- level discovery / retention helpers ----

async function walkData(root: string): Promise<{ abs: string; key: string; bytes: number }[]> {
    const out: { abs: string; key: string; bytes: number }[] = [];
    const walk = async (rel: string[]): Promise<void> => {
        for (const e of await readdirEnts(path.join(root, ...rel))) {
            if (e.isDirectory()) await walk([...rel, e.name]);
            else if (e.name.endsWith(".data")) {
                const abs = path.join(root, ...rel, e.name);
                const bytes = Math.max(0, await sizeOf(abs));
                out.push({ abs, key: [...rel, e.name].join("/"), bytes });
            }
        }
    };
    await walk([]);
    return out;
}

async function pruneEmptyDirs(root: string): Promise<void> {
    const walk = async (rel: string[]): Promise<void> => {
        const abs = path.join(root, ...rel);
        for (const e of await readdirEnts(abs)) {
            if (!e.isDirectory()) continue;
            await walk([...rel, e.name]);
            try { if ((await fsp.readdir(path.join(abs, e.name))).length === 0) await fsp.rmdir(path.join(abs, e.name)); } catch { /* */ }
        }
    };
    await walk([]);
}

function bucketKey(b: { dir: string[]; stem: string }): string { return [...b.dir, b.stem].join("/"); }

// Earliest start / latest end timestamps held by a level (reads only the first
// and last non-empty buckets — buckets are chronological by zero-padded name).
export async function levelTimeBounds(level: number): Promise<{ earliest: number; latest: number }> {
    const bs = (await listLevelBuckets(level)).sort((a, b) => (bucketKey(a) < bucketKey(b) ? -1 : 1));
    let earliest = 0, latest = 0;
    for (let i = 0; i < bs.length; i++) { const { gops } = await combineBucket(level, bs[i].dir, bs[i].stem); if (gops.length) { earliest = gops[0].t; break; } }
    for (let i = bs.length - 1; i >= 0; i--) { const { gops } = await combineBucket(level, bs[i].dir, bs[i].stem); if (gops.length) { latest = gops[gops.length - 1].e; break; } }
    return { earliest, latest };
}

// Bytes currently free on the data disk (available to non-root; 0 if unknown).
async function diskFreeBytes(): Promise<number | null> {
    try { const st: any = await (fsp as any).statfs(DATA_DIR); return st.bavail * st.bsize; } catch { return null; }
}

// The TOTAL byte budget across all levels, sized to the disk RIGHT NOW:
//   our current usage + (free now − reserve)
// i.e. we may grow into free space but always leave DISK_RESERVE_BYTES free; if free
// gets low (something else filling the disk) the budget drops and we reclaim space.
// Floored at MIN_TOTAL_BUDGET_BYTES so we always keep some recent footage.
async function totalBudgetBytes(ourSize: number): Promise<number> {
    const free = await diskFreeBytes();
    if (free == null) return Math.max(MIN_TOTAL_BUDGET_BYTES, ourSize); // can't read disk -> hold steady
    return Math.max(MIN_TOTAL_BUDGET_BYTES, ourSize + free - DISK_RESERVE_BYTES);
}

export async function getLevelsInfo(): Promise<LevelInfo[]> {
    const used = await Promise.all(Array.from({ length: LEVEL_COUNT }, (_, level) =>
        walkData(levelRoot(level)).then(items => items.reduce((s, i) => s + i.bytes, 0))));
    const ourSize = used.reduce((s, b) => s + b, 0);
    const perLevel = Math.floor((await totalBudgetBytes(ourSize)) / LEVEL_COUNT);
    return Promise.all(Array.from({ length: LEVEL_COUNT }, async (_, level): Promise<LevelInfo> => {
        const { earliest, latest } = await levelTimeBounds(level);
        return {
            level, timePerSec: Math.pow(30, level), gopSpanSec: Math.pow(30, level),
            budgetBytes: perLevel, usedBytes: used[level], earliestMs: earliest, latestMs: latest,
        };
    }));
}

// Enforce each level's share of the dynamic budget, deleting that level's oldest
// file buckets first.
export async function enforceRetention(): Promise<{ deleted: string[]; totalBytes: number }> {
    const deleted: string[] = [];
    // Walk every level once: per-level oldest-first items + our total current size.
    const perLevelItems = await Promise.all(Array.from({ length: LEVEL_COUNT }, (_, level) =>
        walkData(levelRoot(level)).then(items => items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)))));
    const ourSize = perLevelItems.reduce((s, items) => s + items.reduce((a, i) => a + i.bytes, 0), 0);
    const perLevel = Math.floor((await totalBudgetBytes(ourSize)) / LEVEL_COUNT);
    let grand = 0;
    for (let level = 0; level < LEVEL_COUNT; level++) {
        const items = perLevelItems[level];
        let total = items.reduce((s, i) => s + i.bytes, 0);
        for (const it of items) {
            if (total <= perLevel) break;
            try { await fsp.rm(it.abs, { force: true }); await fsp.rm(it.abs.slice(0, -5) + ".idx", { force: true }); } catch { /* */ }
            total -= it.bytes; deleted.push(`L${level}/${it.key}`);
        }
        grand += total;
        await pruneEmptyDirs(levelRoot(level));
    }
    return { deleted, totalBytes: grand };
}
