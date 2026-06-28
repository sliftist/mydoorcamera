// RENDER — paints an ImageBitmap (a decoded frame, or the "No video" card) onto a 2D canvas.
// Plain canvas 2D: it retains its content between draws, so pausing or waiting between frames
// just keeps showing the last frame (no flashing). The decode-side fix — caching ImageBitmaps
// instead of holding VideoFrames open — is what made playback fast; rendering was never the
// bottleneck, so there's no need for WebGPU here.

import { clockHMS } from "../format";

type Drawable = ImageBitmap | OffscreenCanvas;

export class Renderer {
    private c2d: CanvasRenderingContext2D | null;
    private sized = false;

    constructor(public canvas: HTMLCanvasElement) {
        this.c2d = canvas.getContext("2d");
    }

    drawImage(source: Drawable): void {
        if (!this.c2d) return;
        if (!this.sized) { this.canvas.width = source.width; this.canvas.height = source.height; this.sized = true; }
        try { this.c2d.drawImage(source as any, 0, 0, this.canvas.width, this.canvas.height); } catch { /* */ }
    }

    drawMissing(wall: number): void {
        if (!this.c2d) return;
        if (!this.sized) { this.canvas.width = 1280; this.canvas.height = 720; this.sized = true; }
        const ctx = this.c2d, w = this.canvas.width, h = this.canvas.height;
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(0, 0, w, h);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font = `${Math.round(h * 0.05)}px sans-serif`;
        ctx.fillText("No video at", w / 2, h / 2 - h * 0.06);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = `${Math.round(h * 0.08)}px monospace`;
        ctx.fillText(clockHMS(wall), w / 2, h / 2 + h * 0.04);
    }

    destroy(): void { /* nothing to clean up for 2D */ }
}
