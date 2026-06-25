// Navigation controller: period selection (scaled to the level's folder span),
// thinning-level switching, URL params, and loading the per-period index.
//
// The navigable PERIOD scales with the thinning level, matching the on-disk
// folder span (see storage bucketOf / config levelPeriod):
//   L0 = a day, L1 = a month, L2+ = a year.
// On selecting a period we download its raw index once and derive coverage +
// activity from it client-side (so the trackbar has full per-GOP detail).

import { runInAction } from "mobx";
import { LevelInfo } from "./api";
import { state } from "./appState";
import { SPEEDS } from "./format";
import { api, player, maybeStartDayPlayer, exitLive } from "./session";
import { decodeIndex, deriveRanges, bucketActivity, IndexGop } from "./indexBuffer";
import { levelPeriod, levelGopSpanSec } from "../../src/config";

function pad(n: number): string { return String(n).padStart(2, "0"); }
function joinMsFor(level: number): number { return Math.max(2500, levelGopSpanSec(level) * 1000 * 1.5); }

// ---- periods ----
export function periodBounds(level: number, ms: number): { start: number; end: number } {
    const d = new Date(ms);
    const p = levelPeriod(level);
    if (p === "day") return { start: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() };
    if (p === "month") return { start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), end: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() };
    return { start: new Date(d.getFullYear(), 0, 1).getTime(), end: new Date(d.getFullYear() + 1, 0, 1).getTime() };
}
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

export function periodHasFootage(level: number, startMs: number): boolean {
    if (level === 0) return state.availableDays.includes(periodKey(0, startMs));
    const li = state.levels.find(l => l.level === level);
    if (!li || !li.latestMs) return false;
    const { start, end } = periodBounds(level, startMs);
    return li.earliestMs < end && li.latestMs > start;
}
// Earliest sub-period of `level` within [from, to) that has footage.
function firstPeriodWithData(level: number, from: number, to: number): number | null {
    let t = periodBounds(level, from).start;
    for (let i = 0; i < 4000 && t < to; i++) {
        if (periodHasFootage(level, t)) return t;
        t = periodBounds(level, t).end;
    }
    return null;
}

// ---- thinning levels ----
export async function refreshLevels(): Promise<void> {
    if (!api) return;
    try { const ls = await api.getLevels(); runInAction(() => { state.levels = ls; }); } catch { /* */ }
}

export function levelOptions(): LevelInfo[] {
    const ls = state.levels.filter(l => l.level === 0 || l.usedBytes > 0);
    return ls.length ? ls : [{ level: 0, timePerSec: 1, gopSpanSec: 1, budgetBytes: 0, usedBytes: 0, earliestMs: 0, latestMs: 0 }];
}

// Remember where we were at each level so switching levels lands sensibly.
const lastPeriodStart: Record<number, number> = {};
const lastPosition: Record<number, number> = {};

export async function setLevel(L: number): Promise<void> {
    if (L === state.level) return;
    if (state.live) await exitLive();
    const anchor = state.playWall || state.desiredWall || (state.coverage ? state.coverage.dayStartMs : Date.now());
    const cur = state.coverage ? { start: state.coverage.dayStartMs, end: state.coverage.dayEndMs } : periodBounds(state.level, anchor);
    // The trackbar zoom is just [viewStart, viewEnd] in absolute time — keep it
    // across the level change (clamped to the new period) so it just works.
    const wasZoomed = !!(state.coverage && state.viewStart && state.viewEnd && (state.viewEnd - state.viewStart) < (cur.end - cur.start) - 1000);
    const keepVs = state.viewStart, keepVe = state.viewEnd;
    runInAction(() => { state.level = L; });
    let target: number;
    let pos: number | undefined;
    const remembered = lastPeriodStart[L];
    if (remembered != null && remembered >= cur.start && remembered < cur.end) {
        target = remembered; pos = lastPosition[L];          // restore the more specific period we had here
    } else {
        const ap = periodBounds(L, anchor);
        if (periodHasFootage(L, ap.start)) { target = ap.start; pos = anchor; } // anchor's period has data
        else { const first = firstPeriodWithData(L, cur.start, cur.end); target = first != null ? first : ap.start; } // first with data
    }
    // Always keep the current playback time when it falls inside the chosen
    // period — switching levels shouldn't move you in time.
    const tb = periodBounds(L, target);
    if (anchor >= tb.start && anchor < tb.end) pos = anchor;
    else if (pos != null && (pos < tb.start || pos >= tb.end)) pos = undefined;
    await selectPeriod(target, false, pos);
    if (wasZoomed && state.coverage && state.index) {
        const ps = state.coverage.dayStartMs, pe = state.coverage.dayEndMs;
        const nvs = Math.max(ps, keepVs), nve = Math.min(pe, keepVe);
        if (nve - nvs > 1000) runInAction(() => { state.viewStart = nvs; state.viewEnd = nve; state.viewActivity = { fromMs: nvs, toMs: nve, activity: bucketActivity(state.index!, nvs, nve, 1440) }; });
    }
    saveUrlPosition(state.playWall);
}

// ---- URL params ----
export function getUrlDay(): string { try { return new URLSearchParams(location.search).get("day") || ""; } catch { return ""; } }
function speedSuffix(): string { return state.speed !== 1 ? `&speed=${state.speed}` : ""; }
function lvlSuffix(): string { return state.level !== 0 ? `&lvl=${state.level}` : ""; }
// Trackbar zoom window as ms-into-period: &z=start-end (omitted when not zoomed).
function zoomSuffix(): string {
    if (!state.coverage) return "";
    const start = state.coverage.dayStartMs, end = state.coverage.dayEndMs;
    const vs = state.viewStart || start, ve = state.viewEnd || end;
    if (vs <= start + 500 && ve >= end - 500) return "";
    return `&z=${Math.round(vs - start)}-${Math.round(ve - start)}`;
}
function extraSuffix(): string { return lvlSuffix() + speedSuffix() + zoomSuffix(); }
export function getUrlZoom(): { vs: number; ve: number } | null {
    try { const v = new URLSearchParams(location.search).get("z"); if (!v) return null; const [a, b] = v.split("-").map(Number); return isFinite(a) && isFinite(b) && b > a ? { vs: a, ve: b } : null; } catch { return null; }
}
// Restore the trackbar zoom from ?z onto the current period (used on initial load).
export function applyUrlZoom(): void {
    const z = getUrlZoom();
    if (!z || !state.coverage || !state.index) return;
    const start = state.coverage.dayStartMs, end = state.coverage.dayEndMs;
    const vs = Math.max(start, start + z.vs), ve = Math.min(end, start + z.ve);
    if (ve - vs < 1000) return;
    runInAction(() => { state.viewStart = vs; state.viewEnd = ve; state.viewActivity = { fromMs: vs, toMs: ve, activity: bucketActivity(state.index!, vs, ve, 1440) }; });
}
export function getUrlSpeed(): number { try { const n = Number(new URLSearchParams(location.search).get("speed")); return SPEEDS.includes(n) ? n : 1; } catch { return 1; } }
export function getUrlLevel(): number { try { const n = Number(new URLSearchParams(location.search).get("lvl")); return n >= 1 && n <= 8 ? Math.floor(n) : 0; } catch { return 0; } }
export function setUrlDay(day: string): void { try { history.pushState({}, "", day ? `?day=${day}${extraSuffix()}` : location.pathname); } catch { /* ignore */ } }
export function getUrlT(): number | null { try { const v = new URLSearchParams(location.search).get("t"); return v == null || v === "" ? null : Number(v); } catch { return null; } }
export function getUrlLive(): boolean { try { return new URLSearchParams(location.search).get("live") === "1"; } catch { return false; } }
export function setUrlLive(on: boolean): void {
    if (!state.day) return;
    try { history.replaceState({}, "", on ? `?day=${state.day}&live=1${extraSuffix()}` : `?day=${state.day}${extraSuffix()}`); } catch { /* ignore */ }
}
export function saveUrlPosition(wall: number): void {
    if (state.live || !state.day || !state.coverage) return;
    const t = Math.max(0, Math.round(wall - state.coverage.dayStartMs)); // ms into period (full precision)
    try { history.replaceState({}, "", `?day=${state.day}&t=${t}${extraSuffix()}`); } catch { /* ignore */ }
}

// ---- period selection / index loading ----
function applyIndex(gops: IndexGop[], start: number, end: number): { start: number; end: number }[] {
    const ranges = deriveRanges(gops, joinMsFor(state.level));
    runInAction(() => {
        state.index = gops;
        state.coverage = { dayStartMs: start, dayEndMs: end, ranges, badRanges: [], activity: [] };
        if (player) player.ranges = ranges;
        const vs = state.viewStart || start, ve = state.viewEnd || end;
        state.viewActivity = { fromMs: vs, toMs: ve, activity: bucketActivity(gops, vs, ve, 1440) };
    });
    return ranges;
}

export async function selectPeriod(startMs: number, push = true, positionWall?: number): Promise<void> {
    if (!api) return;
    const { start, end } = periodBounds(state.level, startMs);
    const key = periodKey(state.level, start);
    if (push) setUrlDay(key);
    let gops: IndexGop[] = [];
    try { gops = decodeIndex(await api.getRawIndex(state.level, start, end)); } catch { gops = []; }
    const ranges = deriveRanges(gops, joinMsFor(state.level));
    let pos = positionWall != null ? positionWall : (ranges.length ? ranges[0].start : start);
    if (positionWall == null && !push) { const t = getUrlT(); if (t != null) pos = start + t; } // ms into period
    pos = Math.max(start, Math.min(end - 1, pos));
    runInAction(() => {
        state.day = key;
        state.index = gops;
        state.coverage = { dayStartMs: start, dayEndMs: end, ranges, badRanges: [], activity: [] };
        state.pickerAnchorMs = start;
        state.playWall = pos; state.desiredWall = pos; state.hoverWall = null;
        state.viewStart = start; state.viewEnd = end;
        state.viewActivity = { fromMs: start, toMs: end, activity: bucketActivity(gops, start, end, 1440) };
    });
    lastPeriodStart[state.level] = start; lastPosition[state.level] = pos;
    maybeStartDayPlayer();
    if (state.level === 0) watchSelectedDay(key);
    else if (lastWatchedDay) { api.unwatchDay(lastWatchedDay); lastWatchedDay = ""; }
}

// Re-download the current period's index (after a reconnect, or when the live day grows).
export async function reloadIndex(): Promise<void> {
    if (!api || !state.coverage) return;
    const start = state.coverage.dayStartMs, end = state.coverage.dayEndMs;
    try { applyIndex(decodeIndex(await api.getRawIndex(state.level, start, end)), start, end); } catch { /* */ }
}

// ---- day watch (L0 live-grow) ----
let lastWatchedDay = "";
let watchReloadTimer: ReturnType<typeof setTimeout> | undefined;
export function watchSelectedDay(dayKey: string): void {
    if (!api) return;
    if (lastWatchedDay && lastWatchedDay !== dayKey) api.unwatchDay(lastWatchedDay);
    lastWatchedDay = dayKey;
    api.watchDay(dayKey, () => {
        if (state.day !== dayKey) return;
        if (watchReloadTimer) clearTimeout(watchReloadTimer);
        watchReloadTimer = setTimeout(() => void reloadIndex(), 1500); // debounced: index grows as capture appends
    }).catch(() => { /* */ });
}
export function rewatchDay(dayKey: string): void { lastWatchedDay = ""; watchSelectedDay(dayKey); }
