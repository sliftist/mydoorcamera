// Session controller: owns the live `api` and `player` singletons and the
// connection / player / live-mode lifecycle. UI and other controllers import the
// live `api` / `player` bindings to read them.

import { runInAction } from "mobx";
import { CameraApi } from "./api";
import { DayPlayer } from "./player";
import { state, lsSet } from "./appState";
import {
    selectDay, refreshLevels, saveUrlPosition, rewatchDay, fetchCoverage,
    getUrlSpeed, getUrlLevel, getUrlDay, getUrlLive, setUrlLive, thisMonth, todayDayStr,
} from "./navigation";

export let api: CameraApi | undefined;
export let player: DayPlayer | undefined;

let playerKey = "";
let videoEl: HTMLVideoElement | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let statsTimer: ReturnType<typeof setInterval> | undefined;
let posTimer: ReturnType<typeof setInterval> | undefined;
let loadTimer: ReturnType<typeof setInterval> | undefined;

// ---- connection ----
export async function connect(): Promise<void> {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
    runInAction(() => { state.error = ""; state.showCertLink = false; state.connecting = true; });
    try {
        api = new CameraApi(state.ip.trim());
        api.onStatus = (c) => runInAction(() => { state.online = c; });
        api.onReconnect = () => { void onReconnected(); };
        await api.connect(state.password);
        lsSet("mdc_ip", state.ip.trim());
        lsSet("mdc_pw", state.password);
        const days = await api.getAvailableDays();
        runInAction(() => { state.view = "browse"; state.availableDays = days; });
        startStatsPoll();
        if (!loadTimer) loadTimer = setInterval(() => { if (api) runInAction(() => { state.loadedBytes = api!.loadedBytes; state.loadRateBps = api!.loadRateBps(); }); }, 1000);
        if (!posTimer) posTimer = setInterval(() => { if (state.day && state.coverage) saveUrlPosition(state.playWall); void refreshLevels(); }, 30000);
        void refreshLevels();
        runInAction(() => { state.speed = getUrlSpeed(); state.level = getUrlLevel(); }); // restore speed + level before the player is created
        const urlDay = getUrlDay();
        const initial = (urlDay && days.includes(urlDay)) ? urlDay : (days[days.length - 1] || "");
        if (initial) await selectDay(initial, false);
        else runInAction(() => { state.calMonth = thisMonth(); });
        if (getUrlLive()) void enterLive(); // resume live mode across refresh
    } catch (e: any) {
        runInAction(() => { state.error = e?.message || String(e); state.showCertLink = !!e?.needsCert; });
        if (e?.needsCert) retryTimer = setTimeout(() => void connect(), 2000);
    } finally {
        runInAction(() => { state.connecting = false; });
    }
}

// Called after the socket auto-reconnects (e.g. server restarted): refresh the
// day list/coverage and resume playback from the current position.
async function onReconnected(): Promise<void> {
    if (!api) return;
    try {
        const days = await api.getAvailableDays();
        runInAction(() => { state.availableDays = days; });
        void refreshLevels();
        if (state.day) { const cov = await fetchCoverage(state.day, state.level); runInAction(() => { state.coverage = cov; }); if (player) player.ranges = cov.ranges; }
    } catch { /* ignore */ }
    if (state.day) rewatchDay(state.day);
    if (state.live && player) { try { await player.startLive(); } catch { /* */ } }
    else if (player) player.seekTo(state.playWall);
}

// ---- stats ----
function startStatsPoll(): void {
    if (statsTimer) return;
    const tick = async () => { if (!api) return; try { const s = await api.getStats(); runInAction(() => { state.stats = s; }); } catch { /* ignore */ } };
    void tick();
    statsTimer = setInterval(() => void tick(), 5000);
}

// ---- player lifecycle ----
export function setVideoEl(el: HTMLVideoElement | null): void {
    videoEl = el;
    if (el) maybeStartDayPlayer();
}

export function maybeStartDayPlayer(): void {
    if (!api || !videoEl || !state.coverage || !state.day) return;
    const key = `${state.day}#${state.level}`;
    if (player && playerKey === key) return;
    teardownPlayer();
    playerKey = key;
    player = new DayPlayer(videoEl, api, state.day.split("/"), state.coverage.dayStartMs, state.coverage.ranges, state.level);
    player.setSpeed(state.speed); // adopt the current (possibly URL-restored) playback speed
    player.onTime = (wall) => runInAction(() => { state.playWall = wall; });
    player.onStatus = (s) => runInAction(() => { state.playStatus = s; });
    player.onRate = (r) => runInAction(() => { state.playbackRate = r; });
    player.onBuffer = (s) => runInAction(() => { state.bufferSec = s; });
    player.seekTo(state.desiredWall); // show the initial / resumed frame (paused), set by selectDay
}

export function teardownPlayer(): void { if (player) { player.teardown(); player = undefined; } playerKey = ""; }

// ---- live mode (full-res real-time only) ----
export async function enterLive(): Promise<void> {
    if (!api) return;
    const today = todayDayStr();
    const needReselect = state.day !== today || state.level !== 0;
    if (state.level !== 0) runInAction(() => { state.level = 0; });
    if (needReselect) await selectDay(today, true);
    if (!player) return;
    runInAction(() => { state.live = true; });
    setUrlLive(true);
    try { await player.startLive(); }
    catch (e) { runInAction(() => { state.live = false; }); setUrlLive(false); console.error("[live] start failed:", e); }
}

export async function exitLive(): Promise<void> {
    runInAction(() => { state.live = false; });
    setUrlLive(false);
    if (player) await player.stopLive();
    if (player && state.coverage && state.coverage.ranges.length) {
        const wall = state.coverage.ranges[state.coverage.ranges.length - 1].end;
        runInAction(() => { state.desiredWall = wall; });
        player.seekTo(wall);
        saveUrlPosition(wall);
    }
}
