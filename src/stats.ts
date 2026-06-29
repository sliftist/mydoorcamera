// System + encoder utilization. The capture daemon samples its own encoder
// throughput/CPU and writes it to a small file; the server reads that plus live
// system stats (CPU / RAM / disk) and serves it all over RPC.

import { promises as fsp } from "fs";
import * as os from "os";

export type SystemStats = {
    cpuPct: number;          // overall CPU utilization, 0..100
    loadAvg: number;         // 1-minute load average
    cores: number;
    ramUsedBytes: number;
    ramTotalBytes: number;
    diskUsedBytes: number;
    diskTotalBytes: number;
    netRxBps: number;        // gross download rate, bytes/sec (all real interfaces)
    netTxBps: number;        // gross upload rate, bytes/sec
    tempC: number | null;    // SoC temperature in °C (null if unreadable)
};

export type EncoderStats = {
    fps: number; cpuPct: number; updatedMs: number;
    jpegDecodeMs?: number;   // avg ms to decode one JPEG (capture -> gray) over the last window
    activityMs?: number;     // avg ms to run the activity check on one frame
    encodeMs?: number;       // avg ms to H.264-encode one (active) GOP
};

const STATS_FILE = "/var/lib/mydoorcamera/encoder-stats.json";

async function cpuTotals(): Promise<{ idle: number; total: number }> {
    const line = (await fsp.readFile("/proc/stat", "utf8")).split("\n")[0];      // "cpu  user nice system idle iowait ..."
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    return { idle: v[3] + (v[4] || 0), total: v.reduce((a, b) => a + b, 0) };
}

// Overall CPU% sampled over `ms` by diffing /proc/stat.
export async function sampleCpuPct(ms = 200): Promise<number> {
    const a = await cpuTotals();
    await new Promise(r => setTimeout(r, ms));
    const b = await cpuTotals();
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
    async sample(): Promise<number> {
        let proc = 0;
        try {
            const s = await fsp.readFile(`/proc/${this.pid}/stat`, "utf8");
            const f = s.slice(s.lastIndexOf(")") + 1).trim().split(/\s+/); // fields after comm
            proc = Number(f[11]) + Number(f[12]);                          // utime + stime (jiffies)
        } catch { return 0; }
        const total = (await cpuTotals()).total;
        const dProc = proc - this.lastProc, dTotal = total - this.lastTotal;
        const had = this.lastTotal > 0;
        this.lastProc = proc; this.lastTotal = total;
        if (!had || dTotal <= 0) return 0;
        return Math.max(0, Math.min(100, (dProc / dTotal) * 100));
    }
}

// Continuous network-rate sampler (gross rx/tx across real interfaces).
let lastNet = { rx: 0, tx: 0, ms: 0 };
let netRate = { rxBps: 0, txBps: 0 };
async function readNetTotals(): Promise<{ rx: number; tx: number }> {
    try {
        let rx = 0, tx = 0;
        for (const line of (await fsp.readFile("/proc/net/dev", "utf8")).split("\n")) {
            const m = line.match(/^\s*([\w.-]+):\s*(.*)$/);
            if (!m || m[1] === "lo") continue;
            const cols = m[2].trim().split(/\s+/).map(Number);
            rx += cols[0] || 0;   // receive bytes
            tx += cols[8] || 0;   // transmit bytes
        }
        return { rx, tx };
    } catch { return { rx: 0, tx: 0 }; }
}
async function sampleNetRate(): Promise<void> {
    const now = Date.now();
    const cur = await readNetTotals();
    if (lastNet.ms) {
        const dt = (now - lastNet.ms) / 1000;
        if (dt > 0) netRate = { rxBps: Math.max(0, (cur.rx - lastNet.rx) / dt), txBps: Math.max(0, (cur.tx - lastNet.tx) / dt) };
    }
    lastNet = { rx: cur.rx, tx: cur.tx, ms: now };
}
setInterval(() => void sampleNetRate(), 2000);
void sampleNetRate();

// SoC temperature from the thermal zone (millidegrees C). Pi throttles ~80-85°C.
async function readTempC(): Promise<number | null> {
    try { const v = Number((await fsp.readFile("/sys/class/thermal/thermal_zone0/temp", "utf8")).trim()); return isFinite(v) ? Math.round(v / 100) / 10 : null; }
    catch { return null; }
}

export async function getSystemStats(dataDir: string): Promise<SystemStats> {
    const cpuPct = await sampleCpuPct(200);
    const tempC = await readTempC();
    const total = os.totalmem(), free = os.freemem();
    let diskUsedBytes = 0, diskTotalBytes = 0;
    try {
        const st: any = await (fsp as any).statfs(dataDir);
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
        netRxBps: Math.round(netRate.rxBps),
        netTxBps: Math.round(netRate.txBps),
        tempC,
    };
}

export async function writeEncoderStats(s: EncoderStats): Promise<void> {
    try { await fsp.writeFile(STATS_FILE, JSON.stringify(s)); } catch { /* ignore */ }
}
export async function readEncoderStats(): Promise<EncoderStats | null> {
    try { return JSON.parse(await fsp.readFile(STATS_FILE, "utf8")) as EncoderStats; } catch { return null; }
}
