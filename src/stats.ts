// System + encoder utilization. The capture daemon samples its own encoder
// throughput/CPU and writes it to a small file; the server reads that plus live
// system stats (CPU / RAM / disk) and serves it all over RPC.

import * as fs from "fs";
import * as os from "os";

export type SystemStats = {
    cpuPct: number;          // overall CPU utilization, 0..100
    loadAvg: number;         // 1-minute load average
    cores: number;
    ramUsedBytes: number;
    ramTotalBytes: number;
    diskUsedBytes: number;
    diskTotalBytes: number;
};

export type EncoderStats = { fps: number; cpuPct: number; updatedMs: number };

const STATS_FILE = "/var/lib/mydoorcamera/encoder-stats.json";

function cpuTotals(): { idle: number; total: number } {
    const line = fs.readFileSync("/proc/stat", "utf8").split("\n")[0];          // "cpu  user nice system idle iowait ..."
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    return { idle: v[3] + (v[4] || 0), total: v.reduce((a, b) => a + b, 0) };
}

// Overall CPU% sampled over `ms` by diffing /proc/stat.
export async function sampleCpuPct(ms = 200): Promise<number> {
    const a = cpuTotals();
    await new Promise(r => setTimeout(r, ms));
    const b = cpuTotals();
    const dIdle = b.idle - a.idle, dTotal = b.total - a.total;
    if (dTotal <= 0) return 0;
    return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
}

// Continuous per-process CPU sampler (for the gstreamer encoder pid). Each call
// returns CPU% (of the whole machine) used since the previous call.
export class ProcCpuSampler {
    private lastProc = 0;
    private lastTotal = 0;
    constructor(private pid: number) {}
    sample(): number {
        let proc = 0;
        try {
            const s = fs.readFileSync(`/proc/${this.pid}/stat`, "utf8");
            const f = s.slice(s.lastIndexOf(")") + 1).trim().split(/\s+/); // fields after comm
            proc = Number(f[11]) + Number(f[12]);                          // utime + stime (jiffies)
        } catch { return 0; }
        const total = cpuTotals().total;
        const dProc = proc - this.lastProc, dTotal = total - this.lastTotal;
        const had = this.lastTotal > 0;
        this.lastProc = proc; this.lastTotal = total;
        if (!had || dTotal <= 0) return 0;
        return Math.max(0, Math.min(100, (dProc / dTotal) * 100));
    }
}

export async function getSystemStats(dataDir: string): Promise<SystemStats> {
    const cpuPct = await sampleCpuPct(200);
    const total = os.totalmem(), free = os.freemem();
    let diskUsedBytes = 0, diskTotalBytes = 0;
    try {
        const st: any = (fs as any).statfsSync(dataDir);
        diskTotalBytes = st.blocks * st.bsize;
        diskUsedBytes = (st.blocks - st.bfree) * st.bsize;
    } catch { /* ignore */ }
    return {
        cpuPct: Math.round(cpuPct),
        loadAvg: Math.round(os.loadavg()[0] * 100) / 100,
        cores: os.cpus().length,
        ramUsedBytes: total - free,
        ramTotalBytes: total,
        diskUsedBytes,
        diskTotalBytes,
    };
}

export function writeEncoderStats(s: EncoderStats): void {
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(s)); } catch { /* ignore */ }
}
export function readEncoderStats(): EncoderStats | null {
    try { return JSON.parse(fs.readFileSync(STATS_FILE, "utf8")) as EncoderStats; } catch { return null; }
}
