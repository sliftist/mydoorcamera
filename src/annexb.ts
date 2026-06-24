// Annex-B H.264 helpers. The capture daemon receives a continuous byte-stream
// from gstreamer (start-code-delimited NALs) and must split it into individual
// NAL units as bytes arrive, across arbitrary chunk boundaries.

export type NalType = "sps" | "pps" | "idr" | "nonidr" | "sei" | "aud" | "other";

export function nalType(nal: Buffer): NalType {
    switch (nal[0] & 0x1f) {
        case 7: return "sps";
        case 8: return "pps";
        case 5: return "idr";      // keyframe slice
        case 1: return "nonidr";   // dependent frame slice
        case 6: return "sei";
        case 9: return "aud";      // access-unit delimiter (we drop these)
        default: return "other";
    }
}

export function isFrame(nal: Buffer): boolean {
    const t = nal[0] & 0x1f;
    return t === 1 || t === 5;
}

export function isKeyframe(nal: Buffer): boolean {
    return (nal[0] & 0x1f) === 5;
}

// Streaming splitter: feed it chunks, it returns the NAL payloads (start codes
// stripped) that are now complete. Keeps an internal tail for the partial NAL.
export class AnnexBSplitter {
    private buf: Buffer = Buffer.alloc(0);

    push(chunk: Buffer): Buffer[] {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        const out: Buffer[] = [];

        // Find every 3-byte start code (00 00 01). A 4-byte code (00 00 00 01)
        // contains it, so this catches both; the leading 0x00 is trimmed off the
        // previous NAL's tail below.
        const starts: number[] = [];
        let i = 0;
        while (i + 2 < this.buf.length) {
            if (this.buf[i] === 0 && this.buf[i + 1] === 0 && this.buf[i + 2] === 1) {
                starts.push(i);
                i += 3;
            } else {
                i++;
            }
        }
        if (starts.length < 2) return out; // need a following start code to know where this NAL ends

        for (let s = 0; s < starts.length - 1; s++) {
            const payloadStart = starts[s] + 3;
            let payloadEnd = starts[s + 1];
            // Trim trailing zero bytes that belong to the next start code (4-byte form).
            while (payloadEnd > payloadStart && this.buf[payloadEnd - 1] === 0) payloadEnd--;
            if (payloadEnd > payloadStart) out.push(Buffer.from(this.buf.subarray(payloadStart, payloadEnd)));
        }

        // Retain from the last start code onward (the still-incomplete NAL).
        this.buf = Buffer.from(this.buf.subarray(starts[starts.length - 1]));
        return out;
    }

    // Emit the final buffered NAL (call on stream end).
    flush(): Buffer[] {
        if (this.buf.length >= 4 && this.buf[0] === 0 && this.buf[1] === 0 && this.buf[2] === 1) {
            const nal = Buffer.from(this.buf.subarray(3));
            this.buf = Buffer.alloc(0);
            if (nal.length) return [nal];
        }
        this.buf = Buffer.alloc(0);
        return [];
    }
}

// On-disk NAL framing: [4-byte big-endian length][bytes], concatenated.
// (Same scheme camera3 uses — compact and trivially seekable with an index.)
export function frameNal(nal: Buffer): Buffer {
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(nal.length, 0);
    return Buffer.concat([len, nal]);
}
