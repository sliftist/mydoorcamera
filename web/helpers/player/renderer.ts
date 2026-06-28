// RENDER — paints the frame the clock hands it. Prefers WebGPU (sampling the VideoFrame
// zero-copy via importExternalTexture, much cheaper than canvas-2D drawImage per frame),
// and falls back to canvas 2D when WebGPU isn't available. Also paints the "No video at
// <clock>" card for gaps / data timeouts.
//
// WebGPU device/pipeline objects have no types in our TS lib, so they're `any` here;
// the VideoFrame the clock passes in stays strongly typed.

import { clockHMS } from "../format";

const SHADER = /* wgsl */`
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) vid: u32) -> VSOut {
    var p = array<vec2f,3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0));
    let xy = p[vid];
    var o: VSOut;
    o.pos = vec4f(xy, 0.0, 1.0);
    o.uv = vec2f((xy.x + 1.0) * 0.5, (1.0 - xy.y) * 0.5); // top-left origin
    return o;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var extTex: texture_external;
@fragment fn fsExt(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureSampleBaseClampToEdge(extTex, samp, uv);
}
@group(0) @binding(1) var tex2d: texture_2d<f32>;
@fragment fn fs2d(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureSample(tex2d, samp, uv);
}`;

export class Renderer {
    private mode: "init" | "webgpu" | "2d" = "init";
    private sized = false;

    // 2D fallback
    private c2d: CanvasRenderingContext2D | null = null;

    // WebGPU state (all `any` — no WebGPU types in lib.dom)
    private gpu: any = null;       // navigator.gpu
    private device: any = null;
    private ctx: any = null;       // GPUCanvasContext
    private format = "";
    private sampler: any = null;
    private pipeExt: any = null;   // external-texture pipeline (video frames)
    private pipe2d: any = null;    // 2d-texture pipeline (missing card)
    private cardTex: any = null;   // GPU texture holding the rendered card
    private card: OffscreenCanvas | undefined; // 2D surface the card is drawn on

    constructor(public canvas: HTMLCanvasElement) {
        void this.init();
    }

    private async init(): Promise<void> {
        const gpu = (navigator as any).gpu;
        if (!gpu) { this.use2d(); return; }
        try {
            const adapter = await gpu.requestAdapter();
            if (!adapter) { this.use2d(); return; }
            const device = await adapter.requestDevice();
            const ctx: any = (this.canvas as any).getContext("webgpu");
            if (!ctx) { this.use2d(); return; }
            const format = gpu.getPreferredCanvasFormat();
            ctx.configure({ device, format, alphaMode: "opaque" });
            const module = device.createShaderModule({ code: SHADER });
            const target = [{ format }];
            this.pipeExt = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fsExt", targets: target }, primitive: { topology: "triangle-list" } });
            this.pipe2d = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs2d", targets: target }, primitive: { topology: "triangle-list" } });
            this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
            this.gpu = gpu; this.device = device; this.ctx = ctx; this.format = format;
            this.mode = "webgpu";
        } catch (e) { console.warn("[render] WebGPU init failed, using canvas 2D", e); this.use2d(); }
    }
    private use2d(): void { this.c2d = this.canvas.getContext("2d"); this.mode = "2d"; }

    private ensureSize(w: number, h: number): void {
        if (this.sized) return;
        this.canvas.width = w; this.canvas.height = h; this.sized = true;
    }

    drawFrame(frame: VideoFrame): void {
        if (this.mode === "init") return; // brief WebGPU init window — drop a frame or two
        this.ensureSize(frame.displayWidth || 1280, frame.displayHeight || 720);
        if (this.mode === "webgpu") {
            try {
                const ext = this.device.importExternalTexture({ source: frame });
                const bind = this.device.createBindGroup({ layout: this.pipeExt.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.sampler }, { binding: 1, resource: ext }] });
                this.pass(this.pipeExt, bind);
            } catch { /* frame closed / context lost */ }
        } else if (this.c2d) {
            try { this.c2d.drawImage(frame as unknown as CanvasImageSource, 0, 0, this.canvas.width, this.canvas.height); } catch { /* */ }
        }
    }

    drawMissing(wall: number): void {
        if (this.mode === "init") return;
        this.ensureSize(1280, 720);
        const card = this.renderCard(wall);
        if (this.mode === "webgpu") {
            try {
                // GPUTextureUsage: COPY_DST(2) | TEXTURE_BINDING(4) | RENDER_ATTACHMENT(16)
                if (!this.cardTex) this.cardTex = this.device.createTexture({ size: [card.width, card.height], format: this.format, usage: 0x2 | 0x4 | 0x10 });
                this.device.queue.copyExternalImageToTexture({ source: card }, { texture: this.cardTex }, [card.width, card.height]);
                const bind = this.device.createBindGroup({ layout: this.pipe2d.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.sampler }, { binding: 1, resource: this.cardTex.createView() }] });
                this.pass(this.pipe2d, bind);
            } catch { /* */ }
        } else if (this.c2d) {
            this.c2d.drawImage(card, 0, 0, this.canvas.width, this.canvas.height);
        }
    }

    private pass(pipeline: any, bind: any): void {
        const enc = this.device.createCommandEncoder();
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
        pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
        this.device.queue.submit([enc.finish()]);
    }

    // Draw the "No video at <clock>" card onto an offscreen 2D surface (reused).
    private renderCard(wall: number): OffscreenCanvas {
        if (!this.card) this.card = new OffscreenCanvas(1280, 720);
        const ctx = this.card.getContext("2d")!;
        const w = this.card.width, h = this.card.height;
        ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, w, h);
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font = `${Math.round(h * 0.05)}px sans-serif`;
        ctx.fillText("No video at", w / 2, h / 2 - h * 0.06);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = `${Math.round(h * 0.08)}px monospace`;
        ctx.fillText(clockHMS(wall), w / 2, h / 2 + h * 0.04);
        return this.card;
    }
}
