// Minimal WebCodecs ambient types — TypeScript 5.3's lib.dom.d.ts predates WebCodecs,
// so these globals aren't declared. We declare only the surface the player uses.
// (No import/export here on purpose, so these are global declarations.)

interface VideoFrame {
    readonly timestamp: number;        // microseconds
    readonly displayWidth: number;
    readonly displayHeight: number;
    close(): void;
}

interface EncodedVideoChunkInit {
    type: "key" | "delta";
    timestamp: number;
    data: BufferSource;
}
declare class EncodedVideoChunk {
    constructor(init: EncodedVideoChunkInit);
    readonly type: "key" | "delta";
    readonly timestamp: number;
}

interface VideoDecoderConfig {
    codec: string;
    optimizeForLatency?: boolean;
    description?: BufferSource;
}
interface VideoDecoderInit {
    output: (frame: VideoFrame) => void;
    error: (error: DOMException) => void;
}
declare class VideoDecoder {
    constructor(init: VideoDecoderInit);
    readonly state: "unconfigured" | "configured" | "closed";
    configure(config: VideoDecoderConfig): void;
    decode(chunk: EncodedVideoChunk): void;
    flush(): Promise<void>;
    reset(): void;
    close(): void;
}
