// mydoorcamera browser app: connect to the Pi's WSS server, pick a day from a
// calendar, and scrub it on a custom coverage-aware trackbar.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { configureMobxNextFrameScheduler } from "sliftutils/render-utils/mobxTyped";
import { css, isNode } from "typesafecss";
import { CameraApi, DayCoverage, Stats } from "./api";
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
}, undefined, { deep: false });

let api: CameraApi | undefined;
let player: DayPlayer | undefined;
let playerKey = "";
let videoEl: HTMLVideoElement | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let statsTimer: ReturnType<typeof setInterval> | undefined;
let posTimer: ReturnType<typeof setInterval> | undefined;
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
        if (!posTimer) posTimer = setInterval(() => { if (state.day && state.coverage) saveUrlPosition(state.playWall); }, 30000);
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

// ---- day selection ----
function getUrlDay(): string { try { return new URLSearchParams(location.search).get("day") || ""; } catch { return ""; } }
function setUrlDay(day: string): void { try { history.pushState({}, "", day ? `?day=${day}` : location.pathname); } catch { /* ignore */ } }
function getUrlT(): number | null { try { const v = new URLSearchParams(location.search).get("t"); return v == null || v === "" ? null : Number(v); } catch { return null; } }
function getUrlLive(): boolean { try { return new URLSearchParams(location.search).get("live") === "1"; } catch { return false; } }
function setUrlLive(on: boolean): void {
    if (!state.day) return;
    try { history.replaceState({}, "", on ? `?day=${state.day}&live=1` : `?day=${state.day}`); } catch { /* ignore */ }
}
// Persist the current position as seconds-of-day in ?t (replaceState, no history spam). Skipped in live mode.
function saveUrlPosition(wall: number): void {
    if (state.live || !state.day || !state.coverage) return;
    const t = Math.max(0, Math.round((wall - state.coverage.dayStartMs) / 1000));
    try { history.replaceState({}, "", `?day=${state.day}&t=${t}`); } catch { /* ignore */ }
}

async function selectDay(dayStr: string, push = true): Promise<void> {
    if (!api) return;
    if (push) setUrlDay(dayStr);
    const cov = await api.getDayCoverage(dayStr.split("/"));
    let startWall = cov.ranges.length ? cov.ranges[0].start : cov.dayStartMs;
    if (!push) { const t = getUrlT(); if (t != null) startWall = cov.dayStartMs + t * 1000; } // resume saved position
    runInAction(() => {
        state.day = dayStr;
        state.coverage = cov;
        state.calMonth = dayStr.slice(0, 7).replace("/", "-");
        state.playWall = startWall; state.desiredWall = startWall; state.hoverWall = null;
    });
    maybeStartDayPlayer();
    watchSelectedDay(dayStr);
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
    if (state.day !== today) await selectDay(today, true);
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
    if (player && playerKey === state.day) return;
    teardownPlayer();
    playerKey = state.day;
    player = new DayPlayer(videoEl, api, state.day.split("/"), state.coverage.dayStartMs, state.coverage.ranges);
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
        if (state.day) { const cov = await api.getDayCoverage(state.day.split("/")); runInAction(() => { state.coverage = cov; }); if (player) player.ranges = cov.ranges; }
    } catch { /* ignore */ }
    if (state.day) { lastWatchedDay = ""; watchSelectedDay(state.day); }
    if (state.live && player) { try { await player.startLive(); } catch { /* */ } }
    else if (player) player.seekTo(state.playWall);
}

// Trackbar drag-seek. We seek on mousedown (responsive), keep seeking while
// dragging, and the player's seek-pump throttles + shows frames.
let trackEl: HTMLElement | null = null;
let dragging = false;
function clientToWall(clientX: number): number | undefined {
    if (!trackEl || !state.coverage) return undefined;
    const r = trackEl.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return state.coverage.dayStartMs + f * (state.coverage.dayEndMs - state.coverage.dayStartMs);
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

const Trackbar = observer(class extends preact.Component { render() {
    const c = state.coverage;
    if (!c) return <div />;
    const span = c.dayEndMs - c.dayStartMs;
    const pct = (w: number) => (Math.min(1, Math.max(0, (w - c.dayStartMs) / span)) * 100).toFixed(3) + "%";
    const wpct = (a: number, b: number) => (Math.max(0, (b - a) / span) * 100).toFixed(3) + "%";
    return (
        <div className={css.vbox(4).width("100%")}>
            <div ref={(el: any) => { trackEl = el; }}
                className={css.relative.width("100%").height(56).hsl(220, 15, 12).border("1px solid hsl(220,15%,28%)")}
                style={{ cursor: "pointer", userSelect: "none" }}
                onMouseDown={onTrackDown}
                onMouseMove={(e: any) => { const w = clientToWall(e.clientX); if (w != null) runInAction(() => { state.hoverWall = w; }); }}
                onMouseLeave={() => { if (!dragging) runInAction(() => { state.hoverWall = null; }); }}>
                {c.ranges.map((r, i) => (
                    <div key={i} style={{ position: "absolute", top: 0, bottom: 0, left: pct(r.start), width: wpct(r.start, r.end), background: "hsl(150,45%,30%)" }} />
                ))}
                {c.badRanges.map((r, i) => (
                    <div key={"b" + i} title="conflicting / bad data" style={{ position: "absolute", top: 0, bottom: 0, left: pct(r.start), width: wpct(r.start, r.end), background: "repeating-linear-gradient(45deg, hsl(0,70%,42%), hsl(0,70%,42%) 6px, hsl(0,70%,26%) 6px, hsl(0,70%,26%) 12px)" }} />
                ))}
                <div style={{ position: "absolute", top: 0, bottom: 0, left: pct(state.desiredWall), width: "2px", background: "hsl(45,100%,58%)" }} title="seek target" />
                <div style={{ position: "absolute", top: 0, bottom: 0, left: pct(state.playWall), width: "2px", background: "hsl(210,100%,66%)" }} title="playing" />
                {state.hoverWall != null && (
                    <div style={{ position: "absolute", top: 0, bottom: 0, left: pct(state.hoverWall), width: "1px", background: "rgba(255,255,255,0.65)" }}>
                        <div style={{ position: "absolute", bottom: "100%", transform: "translateX(-50%)", background: "#000", padding: "2px 6px", fontSize: "11px", whiteSpace: "nowrap", border: "1px solid hsl(220,15%,35%)" }}>{clockHMS(state.hoverWall)}</div>
                    </div>
                )}
            </div>
            <div className={css.hbox(8).fontSize(11).opacity(0.75)} style={{ justifyContent: "space-between" }}>
                <span>{clockHM(c.dayStartMs)}</span>
                <span className={css.opacity(1)}>{clockHMS(state.hoverWall != null ? state.hoverWall : state.playWall)}</span>
                <span>{clockHM(c.dayEndMs - 1)}</span>
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
            <span className={css.fontSize(12).opacity(0.6).flexGrow(1)}>← → seek 5s</span>
            <button className={liveBtnCss} title="Jump to live" onMouseDown={(e: any) => { e.preventDefault(); void enterLive(); }}>● Live</button>
        </div>
    );
} });

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
function shiftMonth(delta: number): void {
    const [y, m] = state.calMonth.split("-").map(Number);
    const d = new Date(y, (m - 1) + delta, 1);
    runInAction(() => { state.calMonth = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; });
}

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

// Arrow keys seek ±5s (routed through the player's throttled seek-pump, so
// holding them shows frames instead of endlessly buffering); space toggles play.
function onKeyDown(e: KeyboardEvent): void {
    if (state.view !== "browse" || !player || !state.coverage) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const base = state.desiredWall || player.currentWall();
        const w = base + (e.key === "ArrowRight" ? 5000 : -5000);
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
