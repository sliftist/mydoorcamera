// RENDER — paints an ImageBitmap (a decoded frame, or the "No video" card) onto the canvas.
// Prefers WebGPU, falling back to canvas 2D. We upload the bitmap into a texture with
// copyExternalImageToTexture and sample it onto a fullscreen triangle. (We deliberately do
// NOT use importExternalTexture: it couples a VideoFrame to one GPU device, which caused
// "texture associated with [Device] cannot be used with [Device]" errors. copyExternalImage
// works regardless of where the bitmap came from.)
//
// The WebGPU device is a single shared instance for the whole page, so there's never a
// two-device mismatch.

import { clockHMS } from "../format";

const SHADER = /* wgsl */`
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) vid: u32) -> VSOut {
    var p = array<vec2f,3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0));
    let xy = p[vid];
    var o: VSOut;
    o.pos = vec4f(xy, 0.0, 1.0);
    o.uv = vec2f((xy.x + 1.0) * 0.5, (1.0 - xy.y) * 0.5);
    return o;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureSample(tex, samp, uv);
}`;

type Drawable = ImageBitmap | OffscreenCanvas;

// One WebGPU device for the whole page (shared by every Renderer / canvas).
let devicePromise: Promise<any> | undefined;
function getDevice(): Promise<any> {
    if (!devicePromise) devicePromise = (async () => {
        const gpu = (navigator as any).gpu;
        if (!gpu) return null;
        try {
            const adapter = await gpu.requestAdapter();
            if (!adapter) return null;
            return await adapter.requestDevice();
        } catch { return null; }
    })();
    return devicePromise;
}

export class Renderer {
    private mode: "init" | "webgpu" | "2d" = "init";
    private sized = false;
    private c2d: CanvasRenderingContext2D | null = null;

    private device: any = null;
    private ctx: any = null;
    private pipe: any = null;
    private sampler: any = null;
    private tex: any = null;
    private texW = 0;
    private texH = 0;
    private card: OffscreenCanvas | undefined;

    constructor(public canvas: HTMLCanvasElement) {
        void this.init();
    }

    private async init(): Promise<void> {
        const gpu = (navigator as any).gpu;
        const device = gpu ? await getDevice() : null;
        if (!device) { this.c2d = this.canvas.getContext("2d"); this.mode = "2d"; return; }
        try {
            const ctx: any = (this.canvas as any).getContext("webgpu");
            const format = gpu.getPreferredCanvasFormat();
            ctx.configure({ device, format, alphaMode: "opaque" });
            const module = device.createShaderModule({ code: SHADER });
            this.pipe = device.createRenderPipeline({
                layout: "auto",
                vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: [{ format }] },
                primitive: { topology: "triangle-list" },
            });
            this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
            this.device = device;
            this.ctx = ctx;
            this.mode = "webgpu";
        } catch (e) {
            console.warn("[render] WebGPU init failed, using canvas 2D", e);
            this.c2d = this.canvas.getContext("2d");
            this.mode = "2d";
        }
    }

    drawImage(source: Drawable): void {
        if (this.mode === "init") return; // brief WebGPU init window
        const w = source.width, h = source.height;
        if (!this.sized) { this.canvas.width = w; this.canvas.height = h; this.sized = true; }
        if (this.mode === "2d") {
            try { this.c2d?.drawImage(source as any, 0, 0, this.canvas.width, this.canvas.height); } catch { /* */ }
            return;
        }
        try {
            if (!this.tex || this.texW !== w || this.texH !== h) {
                if (this.tex) { try { this.tex.destroy(); } catch { /* */ } }
                // GPUTextureUsage: COPY_DST(2) | TEXTURE_BINDING(4) | RENDER_ATTACHMENT(16)
                this.tex = this.device.createTexture({ size: [w, h], format: "rgba8unorm", usage: 0x2 | 0x4 | 0x10 });
                this.texW = w;
                this.texH = h;
            }
            this.device.queue.copyExternalImageToTexture({ source }, { texture: this.tex }, [w, h]);
            const bind = this.device.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.sampler }, { binding: 1, resource: this.tex.createView() }] });
            const enc = this.device.createCommandEncoder();
            const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
            pass.setPipeline(this.pipe);
            pass.setBindGroup(0, bind);
            pass.draw(3);
            pass.end();
            this.device.queue.submit([enc.finish()]);
        } catch { /* device lost / size race */ }
    }

    drawMissing(wall: number): void {
        this.drawImage(this.renderCard(wall));
    }

    private renderCard(wall: number): OffscreenCanvas {
        if (!this.card) this.card = new OffscreenCanvas(1280, 720);
        const ctx = this.card.getContext("2d")!;
        const w = this.card.width, h = this.card.height;
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
        return this.card;
    }
}
