// Session controller: owns the live `api` and `player` singletons and the
// connection / player / live-mode lifecycle. UI and other controllers import the
// live `api` / `player` bindings to read them.

import { runInAction } from "mobx";
import { CameraApi } from "./api";
import { DayPlayer, LivePlayer, Renderer } from "./videoHelpers";
import { state, lsSet } from "./appState";
import {
    selectPeriod, refreshLevels, saveUrlPosition, rewatchDay, reloadIndex, applyUrlZoom,
    periodStartFromKey, todayStart,
    getUrlSpeed, getUrlLevel, getUrlActivityExp, getUrlGapMode, getUrlPanelOpen, getUrlThreshold, applyUrlLoop, getUrlDay, getUrlLive, setUrlLive,
} from "./navigation";

export let api: CameraApi | undefined;
export let player: DayPlayer | undefined;     // review playback (undefined while live)
let livePlayer: LivePlayer | undefined;       // live playback (separate)
let renderer: Renderer | undefined;           // shared canvas renderer (survives player swaps)

let playerKey = "";
let canvasEl: HTMLCanvasElement | null = null;
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
        if (!loadTimer) loadTimer = setInterval(() => {
            if (!api) return;
            runInAction(() => { state.loadedBytes = api!.loadedBytes; state.loadedGops = api!.loadedGops; state.outstandingGops = api!.outstandingGops; state.loadRateBps = api!.loadRateBps(); if (player) state.bufferedRanges = player.bufferedWallRanges(); });
        }, 1000);
        if (!posTimer) posTimer = setInterval(() => { if (state.day && state.coverage) saveUrlPosition(state.playWall); void refreshLevels(); }, 30000);
        void refreshLevels();
        runInAction(() => { state.speed = getUrlSpeed(); state.level = getUrlLevel(); state.activityExp = getUrlActivityExp(); state.gapMode = getUrlGapMode(); state.activityPanelOpen = getUrlPanelOpen(); state.activityThreshold = getUrlThreshold(); }); // restore settings before the player is created
        const urlDay = getUrlDay();
        const anchor = urlDay ? periodStartFromKey(urlDay) : (days.length ? periodStartFromKey(days[days.length - 1]) : 0);
        if (anchor) { await selectPeriod(anchor, false); applyUrlZoom(); applyUrlLoop(); }
        else runInAction(() => { state.pickerAnchorMs = Date.now(); });
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
        if (state.day) await reloadIndex();
    } catch { /* ignore */ }
    if (state.day && state.level === 0) rewatchDay(state.day);
    if (state.live && livePlayer) { try { await livePlayer.start(); } catch { /* */ } } // re-attach the dropped stream
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
export function setCanvasEl(el: HTMLCanvasElement | null): void {
    if (el === canvasEl) return;
    canvasEl = el;
    renderer = el ? new Renderer(el) : undefined; // one renderer per canvas, shared by review + live
    if (el) maybeStartDayPlayer();
}

export function maybeStartDayPlayer(): void {
    if (!api || !renderer || !state.coverage || !state.day || state.live) return;
    const key = `${state.day}#${state.level}`;
    if (player && playerKey === key) return;
    teardownPlayer();
    playerKey = key;
    player = new DayPlayer(renderer, api, state.day.split("/"), state.coverage.dayStartMs, state.coverage.ranges, state.level, state.coverage.dayEndMs);
    player.setSpeed(state.speed); // adopt the current (possibly URL-restored) playback speed
    player.setGapMode(state.gapMode);
    if (state.loopStart && state.loopEnd > state.loopStart) player.setLoop(state.loopStart, state.loopEnd); // loop survives the day/level rebuild
    player.onTime = (wall) => runInAction(() => {
        state.playWall = wall;
        // Sync the intended position (desiredWall) to the playhead ONLY while genuinely
        // playing — never while seeking. Otherwise a seek-in-progress would clobber the
        // intended target back to the old playhead (purple marker snaps off the click /
        // arrow target and "disappears" until the actual playhead catches up).
        if (player && player.playStatus === "playing" && !state.live) state.desiredWall = wall;
    });
    player.onStatus = (s) => runInAction(() => { state.playStatus = s; });
    player.onSeeking = (s) => runInAction(() => { state.seeking = s; });
    player.onDropping = (d) => runInAction(() => { state.dropping = d; });
    player.onPending = () => runInAction(() => { if (player) { state.pendingGops = player.pendingGopTimes; state.bufferedRanges = player.bufferedWallRanges(); } }); // promptly reflect in-flight + loaded GOPs on the markers
    player.seekTo(state.desiredWall); // show the initial / resumed frame (paused), set by selectDay
}

export function teardownPlayer(): void { if (player) { player.teardown(); player = undefined; } playerKey = ""; }

// ---- live mode (full-res real-time only) — a separate LivePlayer on the shared canvas ----
export async function enterLive(): Promise<void> {
    if (!api || !renderer) return;
    const tStart = todayStart();
    const needReselect = state.level !== 0 || !state.coverage || state.coverage.dayStartMs !== tStart;
    if (state.level !== 0) runInAction(() => { state.level = 0; });
    if (needReselect) await selectPeriod(tStart, true);
    runInAction(() => { state.live = true; });
    setUrlLive(true);
    teardownPlayer(); // stop the review player drawing to the shared canvas
    const dayParts = state.day ? state.day.split("/") : [];
    livePlayer = new LivePlayer(renderer, api, dayParts);
    try { await livePlayer.start(); }
    catch (e) { runInAction(() => { state.live = false; }); setUrlLive(false); livePlayer = undefined; console.error("[live] start failed:", e); }
}

export async function exitLive(): Promise<void> {
    runInAction(() => { state.live = false; });
    setUrlLive(false);
    if (livePlayer) { await livePlayer.stop(); livePlayer = undefined; }
    maybeStartDayPlayer(); // rebuild the review player on the shared canvas
    if (player && state.coverage && state.coverage.ranges.length) {
        const wall = state.coverage.ranges[state.coverage.ranges.length - 1].end;
        runInAction(() => { state.desiredWall = wall; });
        player.seekTo(wall);
        saveUrlPosition(wall);
    }
}
