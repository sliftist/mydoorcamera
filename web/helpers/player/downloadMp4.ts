// DOWNLOAD — mux a wall-clock range of raw H.264 GOPs into an MP4 (no re-encode) and
// hand it to the browser as a file download. Uses mp4-muxer for the container; we convert
// the Annex-B NALs to AVCC (4-byte length prefixes) and build the avcC box from SPS/PPS.

import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { FPS } from "../../../src/config";
import { splitFramedNals } from "../../../src/annexb";
import { codecFromSps } from "../h264";
import { pad2 } from "../format";
import { GopSource } from "./gopSource";

export async function downloadRangeMp4(src: GopSource, startWall: number, endWall: number): Promise<void> {
    const gops = (await src.gopsFrom(startWall, 100000)).filter(g => g.t < endWall && !src.isNoChange(g));
    if (!gops.length) throw new Error("no video in the selected range");

    type Sample = { key: boolean; data: Uint8Array; tsUs: number };
    const samples: Sample[] = [];
    let sps: Uint8Array | undefined;
    let pps: Uint8Array | undefined;
    let codec = "";
    const t0 = src.frameWalls(gops[0], gops[0].n)[0] ?? gops[0].t;

    for (const g of gops) {
        const bytes = await src.getBytes(g, true);
        const nals = splitFramedNals(bytes);
        if (!sps) { sps = nals.find(n => (n[0] & 0x1f) === 7); pps = nals.find(n => (n[0] & 0x1f) === 8); codec = codecFromSps(nals); }
        const walls = src.frameWalls(g, g.n);
        // Group NALs into per-frame AVCC access units (SEI stays with its frame; SPS/PPS
        // go in the avcC box, not in-band — required for the avc1 sample entry).
        let sei: Buffer[] = [];
        let fi = 0;
        for (const n of nals) {
            const t = n[0] & 0x1f;
            if (t === 7 || t === 8) continue;
            if (t === 6) { sei.push(n); continue; }
            if (t !== 5 && t !== 1) continue;
            const wall = walls[Math.min(fi, walls.length - 1)] ?? g.t;
            samples.push({ key: t === 5, data: lengthPrefixed([...sei, n]), tsUs: Math.round(((wall - t0) / src.comp) * 1000) });
            sei = [];
            fi++;
        }
    }
    if (!sps || !pps) throw new Error("stream has no SPS/PPS");
    if (!samples.length) throw new Error("no frames in the selected range");

    const { width, height } = parseSpsDims(sps);
    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: "avc", width, height, frameRate: FPS },
        fastStart: "in-memory",
    });
    const description = buildAvcC(sps, pps);
    const frameDurUs = Math.round(1_000_000 / FPS);
    let lastTs = -1;
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const ts = Math.max(s.tsUs, lastTs + 1);
        lastTs = ts;
        const dur = i + 1 < samples.length ? Math.max(1, samples[i + 1].tsUs - ts) : frameDurUs;
        muxer.addVideoChunkRaw(s.data, s.key ? "key" : "delta", ts, dur,
            i === 0 ? { decoderConfig: { codec, description } } : undefined);
    }
    muxer.finalize();

    const d = new Date(startWall);
    const name = `camera-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}.mp4`;
    saveBlob(new Blob([muxer.target.buffer], { type: "video/mp4" }), name);
}

function saveBlob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function lengthPrefixed(nals: Uint8Array[]): Uint8Array {
    let len = 0; for (const n of nals) len += 4 + n.length;
    const out = new Uint8Array(len); let o = 0;
    for (const n of nals) {
        out[o++] = n.length >>> 24; out[o++] = (n.length >>> 16) & 0xff; out[o++] = (n.length >>> 8) & 0xff; out[o++] = n.length & 0xff;
        out.set(n, o); o += n.length;
    }
    return out;
}

function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
    const out = new Uint8Array(11 + sps.length + pps.length);
    let o = 0;
    out[o++] = 1;                       // configurationVersion
    out[o++] = sps[1]; out[o++] = sps[2]; out[o++] = sps[3]; // profile / compat / level
    out[o++] = 0xff;                    // 4-byte NAL lengths
    out[o++] = 0xe1;                    // 1 SPS
    out[o++] = sps.length >>> 8; out[o++] = sps.length & 0xff;
    out.set(sps, o); o += sps.length;
    out[o++] = 1;                       // 1 PPS
    out[o++] = pps.length >>> 8; out[o++] = pps.length & 0xff;
    out.set(pps, o);
    return out;
}

// Coded width/height from the SPS (exp-golomb bit parse, 4:2:0 crop units — what the
// camera produces). Only used to fill the MP4 track header.
function parseSpsDims(sps: Uint8Array): { width: number; height: number } {
    const rbsp: number[] = []; // strip emulation-prevention bytes (00 00 03 -> 00 00)
    for (let i = 1; i < sps.length; i++) {
        if (i + 2 < sps.length && sps[i] === 0 && sps[i + 1] === 0 && sps[i + 2] === 3) { rbsp.push(0, 0); i += 2; continue; }
        rbsp.push(sps[i]);
    }
    let bit = 0;
    const u = (n: number): number => { let v = 0; for (let i = 0; i < n; i++) { v = (v << 1) | ((rbsp[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; } return v; };
    const ue = (): number => { let z = 0; while (u(1) === 0 && z < 32) z++; return (1 << z) - 1 + u(z); };
    const se = (): number => { const k = ue(); return (k & 1) ? (k + 1) >> 1 : -(k >> 1); };
    const skipScaling = (size: number): void => { let last = 8, next = 8; for (let i = 0; i < size; i++) { if (next !== 0) next = (last + se() + 256) % 256; if (next !== 0) last = next; } };

    const profile = u(8); u(16); // constraint flags + level
    ue(); // sps id
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
        const chroma = ue();
        if (chroma === 3) u(1);
        ue(); ue(); u(1);
        if (u(1)) { const n = chroma === 3 ? 12 : 8; for (let i = 0; i < n; i++) if (u(1)) skipScaling(i < 6 ? 16 : 64); }
    }
    ue(); // log2_max_frame_num
    const poc = ue();
    if (poc === 0) ue();
    else if (poc === 1) { u(1); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
    ue(); u(1); // max refs, gaps_allowed
    const widthMbs = ue() + 1;
    const heightUnits = ue() + 1;
    const frameMbsOnly = u(1);
    if (!frameMbsOnly) u(1);
    u(1); // direct_8x8
    let width = widthMbs * 16;
    let height = (2 - frameMbsOnly) * heightUnits * 16;
    if (u(1)) { // frame cropping
        const l = ue(), r = ue(), t = ue(), b = ue();
        width -= (l + r) * 2;
        height -= (t + b) * 2 * (2 - frameMbsOnly);
    }
    if (!(width > 0) || !(height > 0)) return { width: 1920, height: 1080 };
    return { width, height };
}
