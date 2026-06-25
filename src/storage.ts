// On-disk video store. Layout under DATA_DIR:
//   YYYY/MM/DD/HH/seg_<ms>.nal      length-prefixed NAL bytes (rolling segments)
//   YYYY/MM/DD/HH/index.ndjson      one JSON line per GOP: {t,f,o,l,n}
//
// Each GOP is self-contained and immutable: [SPS, PPS, IDR, ...dependent frames].
// The index makes "where are the NALs for time T" an O(log n) lookup: find the
// GOP whose keyframe time is at/just-before T, then read its byte range.

import * as fs from "fs";
import * as path from "path";
import { DATA_DIR, RETENTION_BYTES, FPS } from "./config";
import { frameNal } from "./annexb";

const SEGMENT_MAX_BYTES = 64 * 1024 * 1024;

// One GOP's index record. Short keys keep the index file small.
export type GopEntry = {
    t: number;   // keyframe wall-clock time (ms)
    f: string;   // segment file name
    o: number;   // byte offset of the GOP within the file
    l: number;   // byte length of the GOP
    n: number;   // frame count in the GOP
};

function pad(n: number, w = 2): string { return String(n).padStart(w, "0"); }

export function hourPartsForTime(ms: number): string[] {
    const d = new Date(ms);
    return [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()), pad(d.getHours())];
}

export class StorageWriter {
    private hourDir = "";
    private segFile = "";
    private segPath = "";
    private indexPath = "";
    private segOffset = 0;

    private ensureTarget(ms: number): void {
        const dir = path.join(DATA_DIR, ...hourPartsForTime(ms));
        if (dir === this.hourDir && this.segOffset < SEGMENT_MAX_BYTES) return;
        if (dir !== this.hourDir) {
            fs.mkdirSync(dir, { recursive: true });
            this.hourDir = dir;
            this.indexPath = path.join(dir, "index.ndjson");
        }
        this.newSegment(ms);
    }

    private newSegment(ms: number): void {
        this.segFile = `seg_${ms}.nal`;
        this.segPath = path.join(this.hourDir, this.segFile);
        this.segOffset = 0;
        fs.writeFileSync(this.segPath, Buffer.alloc(0));
    }

    // Persist one self-contained GOP. `nals` = [SPS, PPS, IDR, ...frames].
    writeGop(nals: Buffer[], timeMs: number, frameCount: number): void {
        this.ensureTarget(timeMs);
        const body = Buffer.concat(nals.map(frameNal));
        fs.appendFileSync(this.segPath, body);
        const entry: GopEntry = { t: timeMs, f: this.segFile, o: this.segOffset, l: body.length, n: frameCount };
        fs.appendFileSync(this.indexPath, JSON.stringify(entry) + "\n");
        this.segOffset += body.length;
    }
}

// ---- Read side (used by the server) ----

// List immediate subfolders at a path level (years -> months -> days -> hours).
export function listChildren(parts: string[]): string[] {
    try {
        return fs.readdirSync(path.join(DATA_DIR, ...parts), { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => e.name)
            .sort();
    } catch { return []; }
}

export function readHourIndex(parts: string[]): GopEntry[] {
    try {
        const txt = fs.readFileSync(path.join(DATA_DIR, ...parts, "index.ndjson"), "utf8");
        return txt.split("\n").filter(Boolean).map(l => JSON.parse(l) as GopEntry);
    } catch { return []; }
}

// All days that have footage, as "YYYY/MM/DD" (for the calendar).
export function getAvailableDays(): string[] {
    const out: string[] = [];
    for (const y of listChildren([])) {
        for (const mo of listChildren([y])) {
            for (const d of listChildren([y, mo])) out.push(`${y}/${mo}/${d}`);
        }
    }
    return out;
}

export type DayCoverage = { dayStartMs: number; dayEndMs: number; ranges: { start: number; end: number }[] };

// Coverage for one day: the wall-clock day bounds plus the contiguous ranges
// where video actually exists (so the trackbar can show gaps / dropouts). Built
// by merging every hour's GOP spans, joining across gaps under ~2s.
export function getDayCoverage(parts: string[]): DayCoverage {
    const [y, mo, d] = parts;
    const dayStartMs = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0).getTime();
    const dayEndMs = dayStartMs + 24 * 3600 * 1000;

    const spans: { s: number; e: number }[] = [];
    for (const h of listChildren(parts)) {
        for (const g of readHourIndex([...parts, h])) {
            spans.push({ s: g.t, e: g.t + Math.round((g.n / FPS) * 1000) });
        }
    }
    spans.sort((a, b) => a.s - b.s);

    const ranges: { start: number; end: number }[] = [];
    const JOIN_MS = 2000;
    for (const sp of spans) {
        const last = ranges[ranges.length - 1];
        if (last && sp.s - last.end <= JOIN_MS) last.end = Math.max(last.end, sp.e);
        else ranges.push({ start: sp.s, end: sp.e });
    }
    return { dayStartMs, dayEndMs, ranges };
}

export function readGopBytes(parts: string[], file: string, off: number, len: number): Buffer {
    const fd = fs.openSync(path.join(DATA_DIR, ...parts, file), "r");
    try {
        const b = Buffer.allocUnsafe(len);
        fs.readSync(fd, b, 0, len, off);
        return b;
    } finally { fs.closeSync(fd); }
}

// Rolling retention: delete whole oldest hour-folders until under the byte cap.
// Whole-hour deletion keeps each hour's index self-consistent.
export function enforceRetention(): { deletedHours: string[]; totalBytes: number } {
    const hours: { dir: string; key: string; bytes: number }[] = [];
    const walk = (dir: string, depth: number, keyParts: string[]): void => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        if (depth === 4) {
            let bytes = 0;
            for (const e of entries) {
                if (e.isFile() && e.name.startsWith("seg_")) {
                    try { bytes += fs.statSync(path.join(dir, e.name)).size; } catch { /* ignore */ }
                }
            }
            hours.push({ dir, key: keyParts.join("/"), bytes });
            return;
        }
        for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1, [...keyParts, e.name]);
    };
    walk(DATA_DIR, 0, []);

    let total = hours.reduce((s, h) => s + h.bytes, 0);
    hours.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // chronological (zero-padded)
    const deletedHours: string[] = [];
    for (const h of hours) {
        if (total <= RETENTION_BYTES) break;
        fs.rmSync(h.dir, { recursive: true, force: true });
        total -= h.bytes;
        deletedHours.push(h.key);
    }
    return { deletedHours, totalBytes: total };
}
