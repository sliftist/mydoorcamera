// Navigation controller: day selection, thinning-level switching, and URL params.

import { runInAction } from "mobx";
import { DayCoverage, LevelInfo } from "./api";
import { state } from "./appState";
import { SPEEDS } from "./format";
import { api, player, maybeStartDayPlayer, exitLive } from "./session";

export function thisMonth(): string { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
export function todayDayStr(): string { const d = new Date(); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; }
function pad(n: number): string { return String(n).padStart(2, "0"); }

let lastWatchedDay = "";

// ---- thinning levels ----
// Coverage for a day at the current level. L0 uses the day index; thinned levels
// pull the day's window from the level index (same DayCoverage shape).
export async function fetchCoverage(dayStr: string, level: number): Promise<DayCoverage> {
    const [y, mo, d] = dayStr.split("/").map(Number);
    const dayStartMs = new Date(y, mo - 1, d, 0, 0, 0, 0).getTime();
    const dayEndMs = dayStartMs + 24 * 3600 * 1000;
    if (level === 0) return api!.getDayCoverage(dayStr.split("/"));
    const c = await api!.getLevelCoverage(level, dayStartMs, dayEndMs, 1440);
    return { dayStartMs, dayEndMs, ranges: c.ranges, badRanges: c.badRanges, activity: c.activity };
}

export async function refreshLevels(): Promise<void> {
    if (!api) return;
    try { const ls = await api.getLevels(); runInAction(() => { state.levels = ls; }); } catch { /* */ }
}

export async function setLevel(L: number): Promise<void> {
    if (L === state.level) return;
    if (state.live) await exitLive();             // live is full-res real-time only
    runInAction(() => { state.level = L; });
    if (state.day) await selectDay(state.day, false); // refetch coverage + recreate player at new level
    saveUrlPosition(state.playWall);              // persist &lvl (+t)
}

export function levelOptions(): LevelInfo[] {
    const ls = state.levels.filter(l => l.level === 0 || l.usedBytes > 0);
    return ls.length ? ls : [{ level: 0, timePerSec: 1, gopSpanSec: 1, budgetBytes: 0, usedBytes: 0, earliestMs: 0, latestMs: 0 }];
}

// ---- URL params ----
export function getUrlDay(): string { try { return new URLSearchParams(location.search).get("day") || ""; } catch { return ""; } }
function speedSuffix(): string { return state.speed !== 1 ? `&speed=${state.speed}` : ""; }
function lvlSuffix(): string { return state.level !== 0 ? `&lvl=${state.level}` : ""; }
function extraSuffix(): string { return lvlSuffix() + speedSuffix(); }
export function getUrlSpeed(): number { try { const n = Number(new URLSearchParams(location.search).get("speed")); return SPEEDS.includes(n) ? n : 1; } catch { return 1; } }
export function getUrlLevel(): number { try { const n = Number(new URLSearchParams(location.search).get("lvl")); return n >= 1 && n <= 8 ? Math.floor(n) : 0; } catch { return 0; } }
export function setUrlDay(day: string): void { try { history.pushState({}, "", day ? `?day=${day}${extraSuffix()}` : location.pathname); } catch { /* ignore */ } }
export function getUrlT(): number | null { try { const v = new URLSearchParams(location.search).get("t"); return v == null || v === "" ? null : Number(v); } catch { return null; } }
export function getUrlLive(): boolean { try { return new URLSearchParams(location.search).get("live") === "1"; } catch { return false; } }
export function setUrlLive(on: boolean): void {
    if (!state.day) return;
    try { history.replaceState({}, "", on ? `?day=${state.day}&live=1${extraSuffix()}` : `?day=${state.day}${extraSuffix()}`); } catch { /* ignore */ }
}
// Persist the current position as seconds-of-day in ?t (replaceState, no history spam). Skipped in live mode.
export function saveUrlPosition(wall: number): void {
    if (state.live || !state.day || !state.coverage) return;
    const t = Math.max(0, Math.round((wall - state.coverage.dayStartMs) / 1000));
    try { history.replaceState({}, "", `?day=${state.day}&t=${t}${extraSuffix()}`); } catch { /* ignore */ }
}

// ---- day selection ----
export async function selectDay(dayStr: string, push = true): Promise<void> {
    if (!api) return;
    if (push) setUrlDay(dayStr);
    const cov = await fetchCoverage(dayStr, state.level);
    let startWall = cov.ranges.length ? cov.ranges[0].start : cov.dayStartMs;
    if (!push) { const t = getUrlT(); if (t != null) startWall = cov.dayStartMs + t * 1000; } // resume saved position
    runInAction(() => {
        state.day = dayStr;
        state.coverage = cov;
        state.calMonth = dayStr.slice(0, 7).replace("/", "-");
        state.playWall = startWall; state.desiredWall = startWall; state.hoverWall = null;
        state.viewStart = cov.dayStartMs; state.viewEnd = cov.dayEndMs; // reset trackbar zoom
    });
    maybeStartDayPlayer();
    // Live-grow watch only makes sense for the full-res day index.
    if (state.level === 0) watchSelectedDay(dayStr);
    else if (lastWatchedDay) { api.unwatchDay(lastWatchedDay); lastWatchedDay = ""; }
}

// Watch a day so the trackbar grows as the live capture appends new footage.
export function watchSelectedDay(dayStr: string): void {
    if (!api) return;
    if (lastWatchedDay && lastWatchedDay !== dayStr) api.unwatchDay(lastWatchedDay);
    lastWatchedDay = dayStr;
    api.watchDay(dayStr, (cov) => {
        if (state.day !== dayStr) return;
        runInAction(() => { state.coverage = cov; });
        if (player) player.ranges = cov.ranges; // so coveredAt sees the freshly-added data
    }).catch(() => { /* */ });
}

// Force a fresh watch subscription (used after a reconnect).
export function rewatchDay(dayStr: string): void { lastWatchedDay = ""; watchSelectedDay(dayStr); }
