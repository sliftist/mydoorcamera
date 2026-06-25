// On-disk video store (v2). Per capture session + hour we stream two files
// side by side into the day's directory:
//   YYYY/MM/DD/<HH>.<sessionId>.data   length-prefixed NAL bytes (one GOP after another)
//   YYYY/MM/DD/<HH>.<sessionId>.idx    one JSON line per GOP: {t,e,o,l,n}
//
// A restart makes a new sessionId, so an hour can have several file pairs. On
// read we combine them, ordered by sessionId (the stable "id"). Each GOP's
// [t,e] interval is RESERVED by the first session to claim it; any later GOP
// overlapping a reserved interval is dropped from the index (never served),
// console.warn'd, and reported as a "bad range" so the UI can flag it. We expect
// sessions to be end-to-end at worst; interlaced/overlapping data is the warning.

import * as fs from "fs";
import * as path from "path";
import { DATA_DIR, RETENTION_BYTES, FPS } from "./config";
import { frameNal } from "./annexb";

export type Range = { start: number; end: number };
export type GopEntry = { t: number; e: number; f: string; o: number; l: number; n: number };
export type HourIndex = { gops: GopEntry[]; badRanges: Range[] };
export type DayCoverage = { dayStartMs: number; dayEndMs: number; ranges: Range[]; badRanges: Range[] };

function pad2(n: number): string { return String(n).padStart(2, "0"); }
function dayPartsOf(ms: number): string[] { const d = new Date(ms); return [String(d.getFullYear()), pad2(d.getMonth() + 1), pad2(d.getDate())]; }
function hourOf(ms: number): string { return pad2(new Date(ms).getHours()); }

// Merge overlapping/adjacent ranges. joinMs bridges small gaps (consecutive GOPs
// sit ~1/fps apart, so continuous footage shows as one band, not hundreds).
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

// Unique per process run — distinguishes file pairs written across restarts.
const SESSION = Date.now();

export class StorageWriter {
    private dayDir = "";
    private hour = "";
    private dataPath = "";
    private idxPath = "";
    private offset = 0;

    private ensureTarget(ms: number): void {
        const dir = path.join(DATA_DIR, ...dayPartsOf(ms));
        const hh = hourOf(ms);
        if (dir === this.dayDir && hh === this.hour) return;
        fs.mkdirSync(dir, { recursive: true });
        this.dayDir = dir; this.hour = hh;
        this.dataPath = path.join(dir, `${hh}.${SESSION}.data`);
        this.idxPath = path.join(dir, `${hh}.${SESSION}.idx`);
        try { this.offset = fs.statSync(this.dataPath).size; } catch { this.offset = 0; }
    }

    // One self-contained GOP: [SPS, PPS, IDR, ...frames]; timeMs = keyframe wall-clock.
    writeGop(nals: Buffer[], timeMs: number, frameCount: number): void {
        this.ensureTarget(timeMs);
        const body = Buffer.concat(nals.map(frameNal));
        fs.appendFileSync(this.dataPath, body);
        const e = timeMs + Math.round((frameCount / FPS) * 1000);
        fs.appendFileSync(this.idxPath, JSON.stringify({ t: timeMs, e, o: this.offset, l: body.length, n: frameCount }) + "\n");
        this.offset += body.length;
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

// Combine every session file for one hour, applying the reservation rule.
export function combineHour(parts: string[]): HourIndex {
    const [y, mo, d, hh] = parts;
    const dir = path.join(DATA_DIR, y, mo, d);
    let files: string[];
    try { files = fs.readdirSync(dir); } catch { return { gops: [], badRanges: [] }; }

    const idxFiles = files
        .filter(f => f.startsWith(hh + ".") && f.endsWith(".idx"))
        .map(f => ({ f, session: Number(f.split(".")[1]) || 0 }))
        .sort((a, b) => a.session - b.session); // stable order by session id

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
        const dataFile = f.slice(0, -4) + ".data";
        let recs: any[];
        try { recs = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); }
        catch { continue; }
        for (let i = 0; i < recs.length; i++) {
            const rec = recs[i];
            // Footprint = up to the NEXT keyframe in this session (its real coverage),
            // so consecutive GOPs tile exactly instead of falsely overlapping when the
            // frame-rate estimate (rec.e) drifts from the true spacing. Only genuine
            // cross-session overlap (a restart re-recording covered time) is flagged.
            const footEnd = i + 1 < recs.length ? recs[i + 1].t : rec.e;
            if (overlaps(rec.t, footEnd)) { bad.push({ start: rec.t, end: footEnd }); continue; }
            reserve(rec.t, footEnd);
            gops.push({ t: rec.t, e: rec.e, f: dataFile, o: rec.o, l: rec.l, n: rec.n });
        }
    }
    gops.sort((a, b) => a.t - b.t);
    const badRanges = mergeRanges(bad);
    if (badRanges.length) {
        console.warn(`[storage] interlaced/overlapping data in ${y}/${mo}/${d} ${hh}h: ${bad.length} conflicting GOP(s) ignored across ${badRanges.length} range(s)`);
    }
    return { gops, badRanges };
}

export function getDayCoverage(parts: string[]): DayCoverage {
    const [y, mo, d] = parts;
    const dayStartMs = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0).getTime();
    const dayEndMs = dayStartMs + 24 * 3600 * 1000;
    const good: Range[] = [];
    const bad: Range[] = [];
    for (let h = 0; h < 24; h++) {
        const { gops, badRanges } = combineHour([y, mo, d, pad2(h)]);
        for (const g of gops) good.push({ start: g.t, end: g.e });
        bad.push(...badRanges);
    }
    // Bridge sub-2.5s gaps so continuous capture is one band; bigger gaps = real dropouts.
    return { dayStartMs, dayEndMs, ranges: mergeRanges(good, 2500), badRanges: mergeRanges(bad) };
}

// ---- live streaming helpers ----

// The most-recently-written index file for a day (the live edge).
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

// Read COMPLETE index records appended after `fromByte`. A partially-written
// trailing line (no \n yet) is left for next time. `ends[i]` is the byte offset
// just past record i's line, so a caller can advance only through records it
// actually consumed.
export function readIdxIncremental(parts: string[], idxFile: string, fromByte: number): { records: GopEntry[]; ends: number[]; nextByte: number } {
    const p = path.join(DATA_DIR, ...parts, idxFile);
    let size: number; try { size = fs.statSync(p).size; } catch { return { records: [], ends: [], nextByte: fromByte }; }
    if (size <= fromByte) return { records: [], ends: [], nextByte: fromByte };
    const fd = fs.openSync(p, "r");
    try {
        const buf = Buffer.allocUnsafe(size - fromByte);
        fs.readSync(fd, buf, 0, size - fromByte, fromByte);
        const text = buf.toString("utf8");
        const lastNl = text.lastIndexOf("\n");
        if (lastNl < 0) return { records: [], ends: [], nextByte: fromByte };
        const complete = text.slice(0, lastNl);
        const dataFile = idxFile.slice(0, -4) + ".data";
        const records: GopEntry[] = [], ends: number[] = [];
        let acc = fromByte;
        for (const line of complete.split("\n")) {
            acc += Buffer.byteLength(line, "utf8") + 1;
            if (!line) continue;
            try { const r = JSON.parse(line); records.push({ t: r.t, e: r.e, f: dataFile, o: r.o, l: r.l, n: r.n }); ends.push(acc); } catch { /* */ }
        }
        return { records, ends, nextByte: acc };
    } finally { fs.closeSync(fd); }
}

// True once the GOP's bytes are actually on disk (data is written before index,
// but guard anyway so a reader never serves a hole).
export function dataReady(parts: string[], dataFile: string, o: number, l: number): boolean {
    try { return fs.statSync(path.join(DATA_DIR, ...parts, dataFile)).size >= o + l; } catch { return false; }
}

// Cheap change signature for a day (to detect new data for watchers).
export function daySignature(parts: string[]): string {
    const dir = path.join(DATA_DIR, ...parts);
    let files: string[]; try { files = fs.readdirSync(dir); } catch { return ""; }
    let sig = "";
    for (const f of files.sort()) {
        if (!f.endsWith(".idx")) continue;
        try { const s = fs.statSync(path.join(dir, f)); sig += `${f}:${s.size};`; } catch { /* */ }
    }
    return sig;
}

// `parts` is the day [Y,MM,DD]; `file` is the <HH>.<session>.data name.
export function readGopBytes(parts: string[], file: string, off: number, len: number): Buffer {
    const fd = fs.openSync(path.join(DATA_DIR, ...parts, file), "r");
    try { const b = Buffer.allocUnsafe(len); fs.readSync(fd, b, 0, len, off); return b; }
    finally { fs.closeSync(fd); }
}

// Rolling retention: delete oldest (day/hour/session) file pairs until under cap.
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
    // prune now-empty day folders
    for (const y of listChildren([])) for (const mo of listChildren([y])) for (const d of listChildren([y, mo])) {
        const dir = path.join(DATA_DIR, y, mo, d);
        try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* */ }
    }
    return { deleted, totalBytes: total };
}
