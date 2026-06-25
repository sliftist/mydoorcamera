// mydoorcamera browser app: connect to the Pi's WSS server, pick a day from a
// calendar, and scrub it on a custom coverage-aware trackbar.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { configureMobxNextFrameScheduler } from "sliftutils/render-utils/mobxTyped";
import { css, isNode } from "typesafecss";
import { CameraApi, DayCoverage, Stats, LevelInfo } from "./api";
import { DayPlayer, PlayStatus } from "./player";
import { formatDateTime } from "socket-function/src/formatting/format";
import { BUILD_TIMESTAMP } from "../buildVersion";

const lsGet = (k: string) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const pad2 = (n: number) => String(n).padStart(2, "0");
const clockHM = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const clockHMS = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const state = observable({
    view: "connect" as "connect" | "browse",
    ip: lsGet("mdc_ip"),
    password: lsGet("mdc_pw"),
    error: "",
    showCertLink: false,
    connecting: false,
    availableDays: [] as string[],   // "YYYY/MM/DD"
    day: "",                         // selected "YYYY/MM/DD"
    coverage: null as DayCoverage | null,
    calMonth: "",                    // "YYYY-MM" shown in the calendar
    playWall: 0,                     // actual playhead (wall-clock ms)
    desiredWall: 0,                  // where the user asked to play
    hoverWall: null as number | null,
    stats: null as Stats | null,
    online: true,
    playStatus: "paused" as PlayStatus,
    live: false,
    playbackRate: 1,
    bufferSec: 0,
    speed: 1,
    level: 0,                        // thinning level being viewed (0 = full res)
    levels: [] as LevelInfo[],       // discovery info for the levels panel
    loadedBytes: 0,                  // total bytes received from the server this session
    loadRateBps: 0,                  // avg inbound bytes/sec over the last 60s
    viewStart: 0,                    // trackbar zoom window (ms); 0 => full day
    viewEnd: 0,
}, undefined, { deep: false });

let api: CameraApi | undefined;
let player: DayPlayer | undefined;
let playerKey = "";
let videoEl: HTMLVideoElement | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let statsTimer: ReturnType<typeof setInterval> | undefined;
let posTimer: ReturnType<typeof setInterval> | undefined;
let loadTimer: ReturnType<typeof setInterval> | undefined;
let lastWatchedDay = "";

// ---- connection ----
async function connect(): Promise<void> {
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

function thisMonth(): string { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }

// ---- thinning levels ----
// Coverage for a day at the current level. L0 uses the day index; thinned levels
// pull the day's window from the level index (same DayCoverage shape).
async function fetchCoverage(dayStr: string, level: number): Promise<DayCoverage> {
    const [y, mo, d] = dayStr.split("/").map(Number);
    const dayStartMs = new Date(y, mo - 1, d, 0, 0, 0, 0).getTime();
    const dayEndMs = dayStartMs + 24 * 3600 * 1000;
    if (level === 0) return api!.getDayCoverage(dayStr.split("/"));
    const c = await api!.getLevelCoverage(level, dayStartMs, dayEndMs, 1440);
    return { dayStartMs, dayEndMs, ranges: c.ranges, badRanges: c.badRanges, activity: c.activity };
}

async function refreshLevels(): Promise<void> {
    if (!api) return;
    try { const ls = await api.getLevels(); runInAction(() => { state.levels = ls; }); } catch { /* */ }
}

async function setLevel(L: number): Promise<void> {
    if (L === state.level) return;
    if (state.live) await exitLive();             // live is full-res real-time only
    runInAction(() => { state.level = L; });
    if (state.day) await selectDay(state.day, false); // refetch coverage + recreate player at new level
    saveUrlPosition(state.playWall);              // persist &lvl (+t)
}

// Human duration: "30 s" / "15 min" / "7.5 hr" / "3.2 d" / "5 mo" / "2 yr".
function fmtDur(sec: number): string {
    if (sec <= 0) return "—";
    if (sec < 90) return `${Math.round(sec)} s`;
    const min = sec / 60; if (min < 90) return `${min < 10 ? min.toFixed(1) : Math.round(min)} min`;
    const hr = min / 60; if (hr < 48) return `${hr < 10 ? hr.toFixed(1) : Math.round(hr)} hr`;
    const day = hr / 24; if (day < 60) return `${day < 10 ? day.toFixed(1) : Math.round(day)} d`;
    const mo = day / 30.44; if (mo < 24) return `${mo < 10 ? mo.toFixed(1) : Math.round(mo)} mo`;
    return `${(day / 365).toFixed(1)} yr`;
}
// Level label by time-PER-FRAME — i.e. how much real time each shown frame
// represents (what you'd miss between frames). L1 = 1 frame/sec (you see where
// someone was), L2 = 1 frame / 30s (you only catch lingering things), etc.
function tpfLabel(l: LevelInfo): string { return l.level === 0 ? "full · real-time" : `${fmtDur(Math.pow(30, l.level - 1))} / frame`; }
function levelOptions(): LevelInfo[] {
    const ls = state.levels.filter(l => l.level === 0 || l.usedBytes > 0);
    return ls.length ? ls : [{ level: 0, timePerSec: 1, gopSpanSec: 1, budgetBytes: 0, usedBytes: 0, earliestMs: 0, latestMs: 0 }];
}

// ---- day selection ----
function getUrlDay(): string { try { return new URLSearchParams(location.search).get("day") || ""; } catch { return ""; } }
function speedSuffix(): string { return state.speed !== 1 ? `&speed=${state.speed}` : ""; }
function lvlSuffix(): string { return state.level !== 0 ? `&lvl=${state.level}` : ""; }
function extraSuffix(): string { return lvlSuffix() + speedSuffix(); }
function getUrlSpeed(): number { try { const n = Number(new URLSearchParams(location.search).get("speed")); return SPEEDS.includes(n) ? n : 1; } catch { return 1; } }
function getUrlLevel(): number { try { const n = Number(new URLSearchParams(location.search).get("lvl")); return n >= 1 && n <= 8 ? Math.floor(n) : 0; } catch { return 0; } }
function setUrlDay(day: string): void { try { history.pushState({}, "", day ? `?day=${day}${extraSuffix()}` : location.pathname); } catch { /* ignore */ } }
function getUrlT(): number | null { try { const v = new URLSearchParams(location.search).get("t"); return v == null || v === "" ? null : Number(v); } catch { return null; } }
function getUrlLive(): boolean { try { return new URLSearchParams(location.search).get("live") === "1"; } catch { return false; } }
function setUrlLive(on: boolean): void {
    if (!state.day) return;
    try { history.replaceState({}, "", on ? `?day=${state.day}&live=1${extraSuffix()}` : `?day=${state.day}${extraSuffix()}`); } catch { /* ignore */ }
}
// Persist the current position as seconds-of-day in ?t (replaceState, no history spam). Skipped in live mode.
function saveUrlPosition(wall: number): void {
    if (state.live || !state.day || !state.coverage) return;
    const t = Math.max(0, Math.round((wall - state.coverage.dayStartMs) / 1000));
    try { history.replaceState({}, "", `?day=${state.day}&t=${t}${extraSuffix()}`); } catch { /* ignore */ }
}

async function selectDay(dayStr: string, push = true): Promise<void> {
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
function watchSelectedDay(dayStr: string): void {
    if (!api) return;
    if (lastWatchedDay && lastWatchedDay !== dayStr) api.unwatchDay(lastWatchedDay);
    lastWatchedDay = dayStr;
    api.watchDay(dayStr, (cov) => {
        if (state.day !== dayStr) return;
        runInAction(() => { state.coverage = cov; });
        if (player) player.ranges = cov.ranges; // so coveredAt sees the freshly-added data
    }).catch(() => { /* */ });
}

function todayDayStr(): string { const d = new Date(); return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`; }

async function enterLive(): Promise<void> {
    if (!api) return;
    const today = todayDayStr();
    const needReselect = state.day !== today || state.level !== 0;
    if (state.level !== 0) runInAction(() => { state.level = 0; }); // live is full-res real-time
    if (needReselect) await selectDay(today, true);
    if (!player) return;
    runInAction(() => { state.live = true; });
    setUrlLive(true);
    try { await player.startLive(); }
    catch (e) { runInAction(() => { state.live = false; }); setUrlLive(false); console.error("[live] start failed:", e); }
}

async function exitLive(): Promise<void> {
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

function maybeStartDayPlayer(): void {
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

function teardownPlayer(): void { if (player) { player.teardown(); player = undefined; } playerKey = ""; }

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
    if (state.day) { lastWatchedDay = ""; watchSelectedDay(state.day); }
    if (state.live && player) { try { await player.startLive(); } catch { /* */ } }
    else if (player) player.seekTo(state.playWall);
}

// Trackbar drag-seek. We seek on mousedown (responsive), keep seeking while
// dragging, and the player's seek-pump throttles + shows frames.
let trackEl: HTMLElement | null = null;
let dragging = false;
// The visible trackbar window (zoomable). Falls back to the full day.
function viewBounds(): { vs: number; ve: number } {
    const c = state.coverage!;
    return { vs: state.viewStart || c.dayStartMs, ve: state.viewEnd || c.dayEndMs };
}
function clientToWall(clientX: number): number | undefined {
    if (!trackEl || !state.coverage) return undefined;
    const r = trackEl.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const { vs, ve } = viewBounds();
    return vs + f * (ve - vs);
}
function resetZoom(): void {
    if (!state.coverage) return;
    runInAction(() => { state.viewStart = state.coverage!.dayStartMs; state.viewEnd = state.coverage!.dayEndMs; });
}
// Scroll wheel zooms in/out around the cursor, keeping the time under the cursor fixed.
function onTrackWheel(e: WheelEvent): void {
    if (!state.coverage) return;
    e.preventDefault();
    const c = state.coverage;
    const { vs, ve } = viewBounds();
    const span = ve - vs;
    const cursor = clientToWall(e.clientX);
    if (cursor == null) return;
    const daySpan = c.dayEndMs - c.dayStartMs;
    let newSpan = span * (e.deltaY < 0 ? 0.8 : 1.25);     // up = zoom in, down = zoom out
    newSpan = Math.max(2000, Math.min(daySpan, newSpan)); // 2s min, full day max
    const f = (cursor - vs) / span;                       // keep cursor's time under the cursor
    let ns = cursor - f * newSpan;
    let ne = ns + newSpan;
    if (ns < c.dayStartMs) { ns = c.dayStartMs; ne = ns + newSpan; }
    if (ne > c.dayEndMs) { ne = c.dayEndMs; ns = ne - newSpan; }
    runInAction(() => { state.viewStart = Math.max(c.dayStartMs, ns); state.viewEnd = ne; });
}
function seekToWall(wall: number): void {
    runInAction(() => { state.desiredWall = wall; });
    player?.seekTo(wall);
}
function onTrackDown(e: any): void {
    if (!state.coverage) return;
    e.preventDefault();
    dragging = true;
    const w = clientToWall(e.clientX); if (w != null) { seekToWall(w); saveUrlPosition(w); }
    window.addEventListener("mousemove", onTrackDrag);
    window.addEventListener("mouseup", onTrackUp);
}
function onTrackDrag(e: MouseEvent): void {
    if (!dragging) return;
    const w = clientToWall(e.clientX);
    if (w != null) { runInAction(() => { state.hoverWall = w; }); seekToWall(w); }
}
function onTrackUp(): void {
    dragging = false;
    window.removeEventListener("mousemove", onTrackDrag);
    window.removeEventListener("mouseup", onTrackUp);
    saveUrlPosition(state.desiredWall); // drag finished
}

// ---- stats ----
function startStatsPoll(): void {
    if (statsTimer) return;
    const tick = async () => { if (!api) return; try { const s = await api.getStats(); runInAction(() => { state.stats = s; }); } catch { /* ignore */ } };
    void tick();
    statsTimer = setInterval(() => void tick(), 5000);
}
function gb(b: number): string { return (b / 1073741824).toFixed(1); }
function bps(n: number): string {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + "MB/s";
    if (n >= 1024) return (n / 1024).toFixed(0) + "KB/s";
    return Math.round(n) + "B/s";
}
function fmtBytes(n: number): string {
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
    return n + " B";
}
function formatStats(s: Stats): string {
    const sy = s.system;
    const enc = s.encoder ? `enc ${s.encoder.fps}fps (${s.encoder.cpuPct}%)` : "enc —";
    return `CPU ${sy.cpuPct}% · RAM ${gb(sy.ramUsedBytes)}/${gb(sy.ramTotalBytes)} GB · Disk ${gb(sy.diskUsedBytes)}/${gb(sy.diskTotalBytes)} GB · net ↓${bps(sy.netRxBps)} ↑${bps(sy.netTxBps)} · ${enc}`;
}

// ---- views ----
const ConnectView = observer(class extends preact.Component { render() {
    return (
        <div className={css.vbox(14).width("100%").maxWidth(440)}>
            <h1 className={css.fontSize(28)}>mydoorcamera</h1>
            <div className={css.fontSize(13).opacity(0.8)}>Connect to your camera server on the local network.</div>
            <label className={css.vbox(4)}>
                <span className={css.fontSize(12).opacity(0.7)}>Server IP</span>
                <input className={inputCss} placeholder="e.g. 10.0.0.189" value={state.ip}
                    onInput={e => runInAction(() => { state.ip = (e.target as HTMLInputElement).value; })} />
            </label>
            <label className={css.vbox(4)}>
                <span className={css.fontSize(12).opacity(0.7)}>Password (4 words)</span>
                <input className={inputCss} type="text" autoComplete="off" placeholder="four words" value={state.password}
                    onInput={e => runInAction(() => { state.password = (e.target as HTMLInputElement).value; })}
                    onKeyDown={e => { if (e.key === "Enter") void connect(); }} />
            </label>
            <button className={btnCss} disabled={state.connecting || !state.ip.trim()} onClick={() => void connect()}>
                {state.connecting ? "Connecting…" : "Connect"}
            </button>
            {state.error && (
                <div className={css.vbox(8).pad2(12, 14).hsl(0, 35, 14).border("1px solid hsl(0,45%,32%)")}>
                    <div className={css.color("hsl(0,80%,76%)").fontSize(13)}>{state.error}</div>
                    {state.showCertLink && (
                        <a className={css.fontSize(14).pointer.color("hsl(210,95%,74%)")}
                            href={`https://${state.ip.trim()}:8443/`} target="_blank" rel="noreferrer">
                            → Click here to open the certificate page and accept it — it'll connect automatically.
                        </a>
                    )}
                </div>
            )}
        </div>
    );
} });

// Attach a NON-passive wheel listener so we can preventDefault the page scroll.
function setTrackRef(el: HTMLElement | null): void {
    if (trackEl && trackEl !== el) trackEl.removeEventListener("wheel", onTrackWheel as any);
    trackEl = el;
    if (el) el.addEventListener("wheel", onTrackWheel as any, { passive: false });
}

const Trackbar = observer(class extends preact.Component { render() {
    const c = state.coverage;
    if (!c) return <div />;
    const vs = state.viewStart || c.dayStartMs, ve = state.viewEnd || c.dayEndMs;
    const span = Math.max(1, ve - vs);
    const daySpan = c.dayEndMs - c.dayStartMs;
    const zoomed = span < daySpan - 1000;
    const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
    const pct = (w: number) => (clamp01((w - vs) / span) * 100).toFixed(3) + "%";
    const wpct = (a: number, b: number) => ((clamp01((b - vs) / span) - clamp01((a - vs) / span)) * 100).toFixed(3) + "%";
    const inView = (a: number, b: number) => b > vs && a < ve;
    const TICKS = [1, 2, 3, 4]; // interior label positions (fractions of /5)
    return (
        <div className={css.vbox(4).width("100%")}>
            <div ref={setTrackRef as any}
                className={css.relative.width("100%").height(56).hsl(220, 15, 12).border("1px solid hsl(220,15%,28%)")}
                style={{ cursor: "pointer", userSelect: "none", overflow: "hidden" }}
                onMouseDown={onTrackDown}
                onMouseMove={(e: any) => { const w = clientToWall(e.clientX); if (w != null) runInAction(() => { state.hoverWall = w; }); }}
                onMouseLeave={() => { if (!dragging) runInAction(() => { state.hoverWall = null; }); }}>
                {c.ranges.filter(r => inView(r.start, r.end)).map((r, i) => (
                    <div key={i} style={{ position: "absolute", top: 0, bottom: 0, left: pct(r.start), width: wpct(r.start, r.end), background: "hsl(150,45%,30%)" }} />
                ))}
                {c.badRanges.filter(r => inView(r.start, r.end)).map((r, i) => (
                    <div key={"b" + i} title="conflicting / bad data" style={{ position: "absolute", top: 0, bottom: 0, left: pct(r.start), width: wpct(r.start, r.end), background: "repeating-linear-gradient(45deg, hsl(0,70%,42%), hsl(0,70%,42%) 6px, hsl(0,70%,26%) 6px, hsl(0,70%,26%) 12px)" }} />
                ))}
                {/* Activity line chart: max activity per minute, mapped into the zoom window. */}
                {(() => {
                    const act = c.activity || [];
                    const scale = Math.max(0.05, ...act, 0);
                    const pts: string[] = [];
                    for (let i = 0; i < act.length; i++) {
                        const xf = (c.dayStartMs + i * 60000 - vs) / span;
                        if (xf < -0.02 || xf > 1.02) continue;
                        pts.push(`${(xf * 1000).toFixed(1)},${(100 - Math.min(1, act[i] / scale) * 100).toFixed(1)}`);
                    }
                    return (
                        <svg viewBox="0 0 1000 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
                            <polyline points={pts.join(" ")} fill="none" stroke="hsl(50,100%,65%)" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.9} />
                        </svg>
                    );
                })()}
                {/* Interior time labels, each on its own tick line. */}
                {TICKS.map(k => {
                    const wall = vs + (k / 5) * span;
                    return (
                        <div key={"tk" + k} style={{ position: "absolute", top: 0, bottom: 0, left: ((k / 5) * 100).toFixed(2) + "%", width: "1px", background: "rgba(255,255,255,0.22)", pointerEvents: "none" }}>
                            <div style={{ position: "absolute", top: "1px", left: "3px", fontSize: "9px", color: "rgba(255,255,255,0.75)", whiteSpace: "nowrap", textShadow: "0 0 3px #000, 0 0 3px #000" }}>{clockHMS(wall)}</div>
                        </div>
                    );
                })}
                <div style={{ position: "absolute", top: 0, bottom: 0, left: pct(state.desiredWall), width: "2px", background: "hsl(45,100%,58%)" }} title="seek target" />
                <div style={{ position: "absolute", top: 0, bottom: 0, left: pct(state.playWall), width: "2px", background: "hsl(210,100%,66%)" }} title="playing" />
                {state.hoverWall != null && inView(state.hoverWall, state.hoverWall) && (
                    <div style={{ position: "absolute", top: 0, bottom: 0, left: pct(state.hoverWall), width: "1px", background: "rgba(255,255,255,0.65)" }}>
                        <div style={{ position: "absolute", bottom: "2px", transform: "translateX(-50%)", background: "#000", padding: "2px 6px", fontSize: "11px", whiteSpace: "nowrap", border: "1px solid hsl(220,15%,35%)" }}>{clockHMS(state.hoverWall)}</div>
                    </div>
                )}
            </div>
            <div className={css.hbox(8).fontSize(11).opacity(0.85).alignItems("center")} style={{ justifyContent: "space-between" }}>
                <span style={{ whiteSpace: "nowrap" }}>{formatDateTime(vs)}</span>
                <span className={css.hbox(8).alignItems("center")}>
                    <span style={{ whiteSpace: "nowrap" }}>{clockHMS(state.hoverWall != null ? state.hoverWall : state.playWall)}</span>
                    {zoomed
                        ? <button className={navBtnCss} style={{ fontSize: "11px", padding: "2px 8px" }} onClick={resetZoom} title="Reset zoom (show whole day)">⤢ reset</button>
                        : <span className={css.opacity(0.5)}>· scroll to zoom</span>}
                </span>
                <span style={{ whiteSpace: "nowrap" }}>{formatDateTime(ve)}</span>
            </div>
        </div>
    );
} });

function statusLabel(s: PlayStatus): string {
    return s === "playing" ? "Playing" : s === "paused" ? "Paused" : s === "waiting" ? "Buffering…" : "No video here";
}
function statusColor(s: PlayStatus): string {
    return s === "playing" ? "hsl(150,60%,62%)" : s === "waiting" ? "hsl(45,95%,62%)" : s === "unavailable" ? "hsl(0,75%,64%)" : "hsl(0,0%,72%)";
}
function rateLabel(r: number): string {
    if (Math.abs(r - 1) < 0.005) return "1.00× · in sync";
    const pct = Math.round(Math.abs(r - 1) * 100);
    return `${r.toFixed(2)}× · ${r > 1 ? "catching up +" + pct + "%" : "slowing −" + pct + "%"}`;
}
function rateColor(r: number): string {
    return r > 1.001 ? "hsl(150,60%,60%)" : r < 0.999 ? "hsl(45,90%,62%)" : "hsl(0,0%,65%)";
}

const Controls = observer(class extends preact.Component { render() {
    const playing = state.playStatus === "playing";
    return (
        <div className={css.hbox(12).alignItems("center").width("100%")}>
            <button className={playBtnCss} title="Play/Pause (space)"
                onMouseDown={(e: any) => { e.preventDefault(); player?.togglePlay(); }}>
                {playing ? "❚❚" : "►"}
            </button>
            <span className={css.fontSize(13).width(110)} style={{ color: statusColor(state.playStatus) }}>{statusLabel(state.playStatus)}</span>
            <span className={css.fontSize(12).opacity(0.6).flexGrow(1)}>← → seek {fmtDur(5 * Math.pow(30, state.level))}</span>
            <span className={css.fontSize(13).opacity(0.7)} title="Thinning level — real time each frame represents (what you'd miss between frames)">🔍</span>
            <select className={selectCss} value={String(state.level)} title="Thinning level"
                onChange={(e: any) => void setLevel(Number(e.target.value))}>
                {levelOptions().map(l => <option key={l.level} value={String(l.level)}>{tpfLabel(l)}</option>)}
            </select>
            <span className={css.fontSize(13).opacity(0.7)}>⏩</span>
            <select className={selectCss} value={String(state.speed)}
                onChange={(e: any) => { const s = Number(e.target.value); runInAction(() => { state.speed = s; }); player?.setSpeed(s); saveUrlPosition(state.playWall); }}>
                {SPEEDS.map(s => <option key={s} value={String(s)}>{speedLabel(s)}×</option>)}
            </select>
            <button className={liveBtnCss} title="Jump to live" onMouseDown={(e: any) => { e.preventDefault(); void enterLive(); }}>● Live</button>
        </div>
    );
} });

const SPEEDS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16];
function speedLabel(s: number): string { return s < 1 ? `1/${Math.round(1 / s)}` : String(s); }

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
function shiftMonth(delta: number): void {
    const [y, m] = state.calMonth.split("-").map(Number);
    const d = new Date(y, (m - 1) + delta, 1);
    runInAction(() => { state.calMonth = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; });
}

const LevelsPanel = observer(class extends preact.Component { render() {
    if (!state.levels.length) return <div />;
    return (
        <div className={css.vbox(6).width("100%").maxWidth(420)}>
            <div className={css.fontSize(12).opacity(0.7)}>Thinning levels — time per frame &amp; how far back each reaches (click to view)</div>
            {state.levels.map(l => {
                const heldSec = l.latestMs > l.earliestMs ? (l.latestMs - l.earliestMs) / 1000 : 0;
                const capSec = l.usedBytes > 0 ? heldSec * l.budgetBytes / l.usedBytes : 0;
                const frac = l.budgetBytes > 0 ? Math.min(1, l.usedBytes / l.budgetBytes) : 0;
                const sel = state.level === l.level;
                return (
                    <div key={l.level} onClick={() => void setLevel(l.level)} className={css.vbox(3).pad2(6, 8).pointer}
                        style={{ background: sel ? "hsl(210,55%,20%)" : "hsl(220,15%,13%)", border: "1px solid " + (sel ? "hsl(210,80%,50%)" : "hsl(220,15%,24%)"), borderRadius: "4px" }}>
                        <div className={css.hbox(8).fontSize(12).alignItems("baseline")} style={{ justifyContent: "space-between" }}>
                            <span style={{ fontWeight: 600 }}>{tpfLabel(l)}</span>
                            <span className={css.opacity(0.85)}>{heldSec > 0 ? `held ${fmtDur(heldSec)}` : "empty"}{capSec > 0 ? ` / ~${fmtDur(capSec)} capacity` : ""}</span>
                        </div>
                        <div style={{ position: "relative", height: "5px", background: "hsl(220,15%,22%)", borderRadius: "3px" }}>
                            <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: (frac * 100).toFixed(1) + "%", background: sel ? "hsl(210,90%,58%)" : "hsl(150,45%,40%)", borderRadius: "3px" }} />
                        </div>
                        <div className={css.fontSize(10).opacity(0.5)}>{gb(l.usedBytes)} / {gb(l.budgetBytes)} GB</div>
                    </div>
                );
            })}
        </div>
    );
} });

const Calendar = observer(class extends preact.Component { render() {
    const days = new Set(state.availableDays);
    const [y, m] = (state.calMonth || thisMonth()).split("-").map(Number);
    if (!y || !m) return <div />;
    const monthName = new Date(y, m - 1, 1).toLocaleString([], { month: "long", year: "numeric" });
    const firstWd = new Date(y, m - 1, 1).getDay();
    const numDays = new Date(y, m, 0).getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < firstWd; i++) cells.push(null);
    for (let dd = 1; dd <= numDays; dd++) cells.push(dd);
    return (
        <div className={css.vbox(8).width("100%").maxWidth(340)}>
            <div className={css.hbox(10).alignItems("center")} style={{ justifyContent: "space-between" }}>
                <button className={navBtnCss} onClick={() => shiftMonth(-1)}>‹</button>
                <span className={css.fontSize(14)}>{monthName}</span>
                <button className={navBtnCss} onClick={() => shiftMonth(1)}>›</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: "4px" }}>
                {WEEKDAYS.map((w, i) => <div key={"w" + i} className={css.fontSize(11).opacity(0.5)} style={{ textAlign: "center" }}>{w}</div>)}
                {cells.map((dd, i) => {
                    if (dd == null) return <div key={i} />;
                    const key = `${y}/${pad2(m)}/${pad2(dd)}`;
                    const has = days.has(key);
                    const sel = state.day === key;
                    return (
                        <div key={i} className={css.fontSize(13).pad2(7, 0)}
                            style={{
                                textAlign: "center", borderRadius: "4px", cursor: has ? "pointer" : "default",
                                background: sel ? "hsl(210,90%,45%)" : (has ? "hsl(150,40%,26%)" : "transparent"),
                                color: has || sel ? "#fff" : "hsl(0,0%,38%)",
                            }}
                            onClick={() => { if (has) void selectDay(key); }}>{dd}</div>
                    );
                })}
            </div>
            <div className={css.fontSize(11).opacity(0.5)}>Green = has footage. Pick a day to scrub it above.</div>
        </div>
    );
} });

const DayView = observer(class extends preact.Component { render() {
    const noFootage = state.coverage && state.coverage.ranges.length === 0;
    return (
        <div className={css.vbox(14).width("100%").alignItems("center")}>
            {/* Player fills the first viewport; the date picker is below the fold. */}
            <div className={css.vbox(10).width("100%").maxWidth(1200).alignItems("center")}
                style={{ minHeight: "100vh", justifyContent: "center", padding: "8px 12px", boxSizing: "border-box" }}>
                <video ref={(el: any) => { videoEl = el; if (el) maybeStartDayPlayer(); }} playsInline muted
                    style={{ width: "100%", maxWidth: "1200px", maxHeight: "calc(100vh - 150px)", aspectRatio: "16 / 9", background: "#000", objectFit: "contain", cursor: "pointer" }}
                    onMouseDown={(e: any) => { e.preventDefault(); if (!state.live) { player?.togglePlay(); saveUrlPosition(state.playWall); } }} />
                {state.live
                    ? <div className={css.hbox(14).alignItems("center").width("100%")}>
                        <span className={css.color("hsl(0,85%,62%)").fontSize(15)}>● LIVE</span>
                        <button className={playBtnCss} onMouseDown={(e: any) => { e.preventDefault(); void exitLive(); }}>Exit Live</button>
                        <span className={css.fontSize(13)} style={{ color: rateColor(state.playbackRate) }}>{rateLabel(state.playbackRate)}</span>
                        <span className={css.fontSize(13).opacity(0.8)}>buffered {state.bufferSec.toFixed(1)}s</span>
                    </div>
                    : state.coverage
                        ? <div className={css.vbox(8).width("100%")}><Trackbar /><Controls /></div>
                        : <div className={css.opacity(0.6).fontSize(13)}>Select a day below…</div>}
            </div>
            {!state.live && <div className={css.fontSize(13).opacity(0.75)}>
                {state.day ? state.day.replace(/\//g, "-") : "No day selected"}{noFootage ? " · no footage this day" : ""}
            </div>}
            {!state.live && <Calendar />}
            {!state.live && <LevelsPanel />}
            <div style={{ height: "48px" }} />
        </div>
    );
} });

const App = observer(class extends preact.Component {
    render() {
        return (
            <preact.Fragment>
                {state.view === "connect"
                    ? <div className={css.vbox(0).alignItems("center")} style={{ minHeight: "100vh", justifyContent: "center", padding: "24px", boxSizing: "border-box" }}><ConnectView /></div>
                    : <DayView />}
                {/* Stats + build pinned bottom-right, unaffected by scrolling. */}
                <div style={{ position: "fixed", right: "8px", bottom: "6px", fontSize: "11px", color: "rgba(255,255,255,0.65)", textAlign: "right", background: "rgba(0,0,0,0.45)", padding: "3px 8px", borderRadius: "4px", pointerEvents: "none", lineHeight: "1.5", maxWidth: "92vw" }}>
                    {state.view === "browse" && !state.online && <div style={{ color: "hsl(40,95%,62%)" }}>● reconnecting…</div>}
                    {state.view === "browse" && <div>Loaded {fmtBytes(state.loadedBytes)} · {bps(state.loadRateBps)}</div>}
                    {state.stats && <div>{formatStats(state.stats)}</div>}
                    <div>Build {formatDateTime(BUILD_TIMESTAMP)}</div>
                </div>
            </preact.Fragment>
        );
    }
});

const inputCss = css.fontSize(15).pad2(10, 12).hsl(220, 15, 16).color("inherit").border("1px solid hsl(220,15%,30%)").width("100%").toString();
const btnCss = css.fontSize(15).pad2(10, 18).hsl(220, 90, 55).color("white").border("none").pointer.toString();
const navBtnCss = css.fontSize(16).pad2(4, 12).hsl(220, 15, 18).color("inherit").border("1px solid hsl(220,15%,30%)").pointer.toString();
const playBtnCss = css.fontSize(16).pad2(8, 16).hsl(220, 90, 55).color("white").border("none").pointer.toString();
const liveBtnCss = css.fontSize(14).pad2(8, 14).hsl(0, 75, 48).color("white").border("none").pointer.toString();
const selectCss = css.fontSize(13).pad2(6, 8).hsl(220, 15, 16).color("inherit").border("1px solid hsl(220,15%,30%)").pointer.toString();

// Arrow keys seek ±5s (routed through the player's throttled seek-pump, so
// holding them shows frames instead of endlessly buffering); space toggles play.
function onKeyDown(e: KeyboardEvent): void {
    if (state.view !== "browse" || !player || !state.coverage) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const base = state.desiredWall || player.currentWall();
        const step = 5000 * (player.compression || 1); // scale by the level's time density
        const w = base + (e.key === "ArrowRight" ? step : -step);
        runInAction(() => { state.desiredWall = w; });
        player.seekTo(w);
    } else if (e.key === " ") {
        e.preventDefault();
        player.togglePlay();
    }
}

function main(): void {
    configureMobxNextFrameScheduler();
    preact.render(<App />, document.getElementById("app")!);
    window.addEventListener("popstate", () => { if (state.view === "browse" && api) { const d = getUrlDay(); if (d) void selectDay(d, false); } });
    window.addEventListener("keydown", onKeyDown);
    if (state.ip.trim() && state.password.trim()) void connect();
}
if (!isNode()) main();
