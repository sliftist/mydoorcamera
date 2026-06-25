// Pure display formatters + small UI constants. No state, no side effects.

import { LevelInfo, Stats } from "./api";
import { PlayStatus } from "./videoHelpers";

export const pad2 = (n: number): string => String(n).padStart(2, "0");
export const clockHMS = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const SPEEDS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16];
export function speedLabel(s: number): string { return s < 1 ? `1/${Math.round(1 / s)}` : String(s); }

// Human duration: "30 s" / "15 min" / "7.5 hr" / "3.2 d" / "5 mo" / "2 yr".
export function fmtDur(sec: number): string {
    if (sec <= 0) return "—";
    if (sec < 90) return `${Math.round(sec)} s`;
    const min = sec / 60; if (min < 90) return `${min < 10 ? min.toFixed(1) : Math.round(min)} min`;
    const hr = min / 60; if (hr < 48) return `${hr < 10 ? hr.toFixed(1) : Math.round(hr)} hr`;
    const day = hr / 24; if (day < 60) return `${day < 10 ? day.toFixed(1) : Math.round(day)} d`;
    const mo = day / 30.44; if (mo < 24) return `${mo < 10 ? mo.toFixed(1) : Math.round(mo)} mo`;
    return `${(day / 365).toFixed(1)} yr`;
}

// Level label by time-PER-FRAME — how much real time each shown frame represents
// (what you'd miss between frames). L1 = 1 s/frame (you see where someone was),
// L2 = 30 s/frame (you only catch lingering things), etc.
export function tpfLabel(l: LevelInfo): string {
    return l.level === 0 ? "full · real-time" : `${fmtDur(Math.pow(30, l.level - 1))} / frame`;
}

export function gb(b: number): string { return (b / 1073741824).toFixed(1); }
export function bps(n: number): string {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + "MB/s";
    if (n >= 1024) return (n / 1024).toFixed(0) + "KB/s";
    return Math.round(n) + "B/s";
}
export function fmtBytes(n: number): string {
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
    return n + " B";
}
export function formatStats(s: Stats): string {
    const sy = s.system;
    const enc = s.encoder ? `enc ${s.encoder.fps}fps (${s.encoder.cpuPct}%)` : "enc —";
    return `CPU ${sy.cpuPct}% · RAM ${gb(sy.ramUsedBytes)}/${gb(sy.ramTotalBytes)} GB · Disk ${gb(sy.diskUsedBytes)}/${gb(sy.diskTotalBytes)} GB · net ↓${bps(sy.netRxBps)} ↑${bps(sy.netTxBps)} · ${enc}`;
}

export function statusLabel(s: PlayStatus): string {
    return s === "playing" ? "Playing" : s === "paused" ? "Paused" : s === "waiting" ? "Buffering…" : "No video here";
}
export function statusColor(s: PlayStatus): string {
    return s === "playing" ? "hsl(150,60%,62%)" : s === "waiting" ? "hsl(45,95%,62%)" : s === "unavailable" ? "hsl(0,75%,64%)" : "hsl(0,0%,72%)";
}
export function rateLabel(r: number): string {
    if (Math.abs(r - 1) < 0.005) return "1.00× · in sync";
    const pct = Math.round(Math.abs(r - 1) * 100);
    return `${r.toFixed(2)}× · ${r > 1 ? "catching up +" + pct + "%" : "slowing −" + pct + "%"}`;
}
export function rateColor(r: number): string {
    return r > 1.001 ? "hsl(150,60%,60%)" : r < 0.999 ? "hsl(45,90%,62%)" : "hsl(0,0%,65%)";
}
