// RENDER — owns the canvas and paints whatever frame the clock asks for. It reads the
// shared FrameCache; on a hit it draws immediately; on a miss it kicks a live decode (so
// the frame appears for a later tick) and reports the miss to the clock, which decides
// whether to wait or skip. The renderer is self-sufficient: it never depends on the
// pre-buffer having run.

import { RenderResult } from "./types";
import { GopSource } from "./gopSource";
import { FrameCache } from "./frameCache";
import { GopDecoder } from "./gopDecoder";
import { clockHMS } from "../format";

export class Renderer {
    private c2d: CanvasRenderingContext2D | null;
    private sized = false;

    constructor(
        public canvas: HTMLCanvasElement,
        private source: GopSource,
        private cache: FrameCache,
        private decoder: GopDecoder,
    ) {
        this.c2d = canvas.getContext("2d");
    }

    // Try to show the frame for `wall`. Hit = an on-time frame was drawn. Miss = not
    // available yet (a decode was kicked); the canvas keeps its previous contents.
    renderAt(wall: number, priority: boolean): RenderResult {
        const tol = this.source.frameStep * 1.5;
        const exact = this.cache.getExact(wall, tol);
        if (exact) { this.drawFrame(exact.frame); return "hit"; }
        void this.decoder.ensureWall(wall, priority); // populate the cache for a later tick
        return "miss";
    }

    // Draw the nearest available frame at/before `wall` (used in skip mode / while waiting).
    drawNearest(wall: number): boolean {
        const b = this.cache.getAtOrBefore(wall);
        if (b) { this.drawFrame(b.frame); return true; }
        return false;
    }

    drawFrame(frame: any): void {
        if (!this.c2d) return;
        if (!this.sized && frame.displayWidth) { this.canvas.width = frame.displayWidth; this.canvas.height = frame.displayHeight; this.sized = true; }
        try { this.c2d.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height); } catch { /* frame closed */ }
    }

    // "No video at <clock>" card — for coverage gaps and the 5s data-timeout.
    drawMissing(wall: number): void {
        if (!this.c2d) return;
        if (!this.sized) { this.canvas.width = 1280; this.canvas.height = 720; this.sized = true; }
        const ctx = this.c2d, w = this.canvas.width, h = this.canvas.height;
        ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, w, h);
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font = `${Math.round(h * 0.05)}px sans-serif`;
        ctx.fillText("No video at", w / 2, h / 2 - h * 0.06);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = `${Math.round(h * 0.08)}px monospace`;
        ctx.fillText(clockHMS(wall), w / 2, h / 2 + h * 0.04);
    }
}
