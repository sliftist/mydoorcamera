// Shared H.264 / WebCodecs glue used by both the player (videoHelpers.ts) and the
// thumbnail decoder (thumbnails.ts). Turns the on-disk length-prefixed NAL stream of
// a GOP into per-frame Annex-B access units ready to hand to a VideoDecoder.
//
// We decode in Annex-B mode (start-code-delimited, SPS/PPS in-band) — VideoDecoder
// accepts this when configured with just { codec } and no `description`.

import { splitFramedNals } from "../../src/annexb";

const START = new Uint8Array([0, 0, 0, 1]);

// avc1.PPCCLL codec string from the SPS (profile/constraint/level bytes). Falls back
// to a common Main@4.0 string if the SPS is missing/short.
export function codecFromSps(nals: Buffer[]): string {
    const sps = nals.find(n => (n[0] & 0x1f) === 7);
    if (!sps || sps.length < 4) return "avc1.4D0028";
    const hex = (b: number) => b.toString(16).padStart(2, "0");
    return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

function concat(parts: Uint8Array[]): Uint8Array {
    let len = 0; for (const p of parts) len += p.length;
    const out = new Uint8Array(len); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

export type AccessUnit = { key: boolean; data: Uint8Array };

// Group a GOP's framed NALs into per-frame Annex-B access units. Parameter sets
// (SPS/PPS) and SEI accumulate as a prefix; each VCL slice closes one access unit:
//   IDR  (type 5) -> key frame, prefixed with the pending SPS/PPS/SEI
//   non-IDR (type 1) -> delta frame (its own slice only)
// A normal GOP is [SPS,PPS,IDR,P,P,...] so the first AU is a self-contained keyframe.
export function splitAccessUnits(nals: Buffer[]): AccessUnit[] {
    const out: AccessUnit[] = [];
    let prefix: Uint8Array[] = [];
    for (const n of nals) {
        const t = n[0] & 0x1f;
        if (t === 7 || t === 8 || t === 6) { prefix.push(START, n); continue; } // SPS/PPS/SEI
        if (t === 5) { out.push({ key: true, data: concat([...prefix, START, n]) }); prefix = []; continue; }
        if (t === 1) { out.push({ key: false, data: concat([START, n]) }); continue; }
        // AUD (9) / other: ignore
    }
    return out;
}

// Convenience: access units straight from a raw GOP blob (length-prefixed NALs).
export function accessUnitsFromGop(buf: Buffer): { nals: Buffer[]; units: AccessUnit[] } {
    const nals = splitFramedNals(buf);
    return { nals, units: splitAccessUnits(nals) };
}
