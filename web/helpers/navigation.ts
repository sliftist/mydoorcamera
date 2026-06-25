// Navigation controller: period selection (scaled to the level's folder span),
// thinning-level switching, and URL params.
//
// The navigable PERIOD scales with the thinning level, matching the on-disk
// folder span (see storage bucketOf / config levelPeriod):
//   L0 = a day, L1 = a month, L2+ = a year.
// state.coverage / the trackbar span the period; the date picker picks at that
// granularity (day, month, or year) and never finer.

import { runInAction } from "mobx";
import { DayCoverage, LevelInfo } from "./api";
import { state } from "./appState";
import { SPEEDS } from "./format";
import { api, player, maybeStartDayPlayer, exitLive } from "./session";
import { levelPeriod } from "../../src/config";

function pad(n: number): string { return String(n).padStart(2, "0"); }

// ---- periods ----
// Bounds (local time) of the period of `level` containing `ms`.
export function periodBounds(level: number, ms: number): { start: number; end: number } {
    const d = new Date(ms);
    const p = levelPeriod(level);
    if (p === "day") return { start: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() };
    if (p === "month") return { start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), end: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() };
    return { start: new Date(d.getFullYear(), 0, 1).getTime(), end: new Date(d.getFullYear() + 1, 0, 1).getTime() };
}
// URL/key for a period: "YYYY/MM/DD" (day), "YYYY/MM" (month), "YYYY" (year).
export function periodKey(level: number, ms: number): string {
    const d = new Date(ms); const p = levelPeriod(level);
    const Y = d.getFullYear(), M = pad(d.getMonth() + 1), D = pad(d.getDate());
    return p === "day" ? `${Y}/${M}/${D}` : p === "month" ? `${Y}/${M}` : `${Y}`;
}
export function periodStartFromKey(key: string): number {
    const [y, m, d] = key.split("/").map(Number);
    return new Date(y, (m || 1) - 1, d || 1).getTime();
}
export function todayStart(): number { return periodBounds(0, Date.now()).start; }

// Does the period at `level` containing `startMs` have any footage?
export function periodHasFootage(level: number, startMs: number): boolean {
    if (level === 0) return state.availableDays.includes(periodKey(0, startMs));
    const li = state.levels.find(l => l.level === level);
    if (!li || !li.latestMs) return false;
    const { start, end } = periodBounds(level, startMs);
    return li.earliestMs < end && li.latestMs > start;
}

// ---- thinning levels ----
export async function fetchCoverage(start: number, end: number, level: number): Promise<DayCoverage> {
    if (level === 0) return api!.getDayCoverage(periodKey(0, start).split("/"));
    const c = await api!.getLevelCoverage(level, start, end, 1440);
    return { dayStartMs: start, dayEndMs: end, ranges: c.ranges, badRanges: c.badRanges, activity: c.activity };
}

export async function refreshLevels(): Promise<void> {
    if (!api) return;
    try { const ls = await api.getLevels(); runInAction(() => { state.levels = ls; }); } catch { /* */ }
}

export async function setLevel(L: number): Promise<void> {
    if (L === state.level) return;
    if (state.live) await exitLive();             // live is full-res real-time only
    const anchor = state.playWall || state.desiredWall || (state.coverage ? state.coverage.dayStartMs : Date.now());
    runInAction(() => { state.level = L; });
    await selectPeriod(anchor, false, anchor);    // select the new level's period around the current position
    saveUrlPosition(state.playWall);              // persist &lvl (+t, +day key)
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
// Persist the current position as seconds-into-period in ?t (replaceState). Skipped in live mode.
export function saveUrlPosition(wall: number): void {
    if (state.live || !state.day || !state.coverage) return;
    const t = Math.max(0, Math.round((wall - state.coverage.dayStartMs) / 1000));
    try { history.replaceState({}, "", `?day=${state.day}&t=${t}${extraSuffix()}`); } catch { /* ignore */ }
}

// ---- period selection ----
export async function selectPeriod(startMs: number, push = true, positionWall?: number): Promise<void> {
    if (!api) return;
    const { start, end } = periodBounds(state.level, startMs);
    const key = periodKey(state.level, start);
    if (push) setUrlDay(key);
    const cov = await fetchCoverage(start, end, state.level);
    let pos = positionWall != null ? positionWall : (cov.ranges.length ? cov.ranges[0].start : start);
    if (positionWall == null && !push) { const t = getUrlT(); if (t != null) pos = start + t * 1000; } // resume saved position
    pos = Math.max(start, Math.min(end - 1, pos));
    runInAction(() => {
        state.day = key;
        state.coverage = cov;
        state.pickerAnchorMs = start;
        state.playWall = pos; state.desiredWall = pos; state.hoverWall = null;
        state.viewStart = start; state.viewEnd = end; // reset trackbar zoom to the whole period
    });
    maybeStartDayPlayer();
    // Live-grow watch only makes sense for the full-res day index.
    if (state.level === 0) watchSelectedDay(key);
    else if (lastWatchedDay) { api.unwatchDay(lastWatchedDay); lastWatchedDay = ""; }
}

// ---- day watch (L0 live-grow) ----
let lastWatchedDay = "";
export function watchSelectedDay(dayKey: string): void {
    if (!api) return;
    if (lastWatchedDay && lastWatchedDay !== dayKey) api.unwatchDay(lastWatchedDay);
    lastWatchedDay = dayKey;
    api.watchDay(dayKey, (cov) => {
        if (state.day !== dayKey) return;
        runInAction(() => { state.coverage = cov; });
        if (player) player.ranges = cov.ranges; // so coveredAt sees the freshly-added data
    }).catch(() => { /* */ });
}
export function rewatchDay(dayKey: string): void { lastWatchedDay = ""; watchSelectedDay(dayKey); }
