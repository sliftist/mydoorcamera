// RENDER — paints an ImageBitmap (a decoded frame, or the "No video" card) onto a 2D canvas.
// Plain canvas 2D: it retains its content between draws, so pausing or waiting between frames
// just keeps showing the last frame (no flashing). The decode-side fix — caching ImageBitmaps
// instead of holding VideoFrames open — is what made playback fast; rendering was never the
// bottleneck, so there's no need for WebGPU here.

import { clockHMS, dateYMD } from "../format";

type Drawable = ImageBitmap | OffscreenCanvas;

export class Renderer {
    private c2d: CanvasRenderingContext2D | null;
    private sized = false;

    constructor(public canvas: HTMLCanvasElement) {
        this.c2d = canvas.getContext("2d");
    }

    // Paint a frame and overlay the clock for `wall` (the timestamp is no longer burned into the
    // video — capture dropped the SW drawtext to stay realtime — so we draw it here from the exact
    // stored frame time). `note` adds context (e.g. "no activity") next to the clock.
    drawImage(source: Drawable, wall?: number, note?: string): void {
        if (!this.c2d) return;
        if (!this.sized) { this.canvas.width = source.width; this.canvas.height = source.height; this.sized = true; }
        try { this.c2d.drawImage(source as any, 0, 0, this.canvas.width, this.canvas.height); } catch { /* */ }
        if (wall != null) this.drawClock(wall, note);
    }

    // Compact top-left chip: date line over time line (mirrors the old burned-in overlay).
    private drawClock(wall: number, note?: string): void {
        const ctx = this.c2d!, w = this.canvas.width, h = this.canvas.height;
        const dateStr = dateYMD(wall);
        const timeStr = clockHMS(wall) + (note ? ` · ${note}` : "");
        const fs = Math.max(11, Math.round(h * 0.035));
        ctx.font = `${fs}px monospace`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const padX = Math.round(fs * 0.5), padY = Math.round(fs * 0.35), gap = Math.round(fs * 0.25);
        const tw = Math.max(ctx.measureText(dateStr).width, ctx.measureText(timeStr).width);
        const x = Math.round(w * 0.012), y = Math.round(h * 0.012);
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(x, y, tw + padX * 2, fs * 2 + gap + padY * 2);
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.fillText(dateStr, x + padX, y + padY + fs / 2);
        ctx.fillText(timeStr, x + padX, y + padY + fs + gap + fs / 2);
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
        ctx.fillText("No video at", w / 2, h / 2 - h * 0.1);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = `${Math.round(h * 0.05)}px monospace`;
        ctx.fillText(dateYMD(wall), w / 2, h / 2 - h * 0.01);
        ctx.font = `${Math.round(h * 0.08)}px monospace`;
        ctx.fillText(clockHMS(wall), w / 2, h / 2 + h * 0.08);
    }

    destroy(): void { /* nothing to clean up for 2D */ }
}
