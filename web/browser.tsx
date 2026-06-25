// mydoorcamera browser app: connect to the Pi's WSS server, navigate footage by
// date (year/month/day/hour), and play an hour with a seekable scrubber.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { configureMobxNextFrameScheduler } from "sliftutils/render-utils/mobxTyped";
import { css, isNode } from "typesafecss";
import { CameraApi, GopEntry } from "./api";
import { Player } from "./player";
import { BUILD_TIMESTAMP } from "../buildVersion";

const lsGet = (k: string) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

const state = observable({
    view: "connect" as "connect" | "browse",
    ip: lsGet("mdc_ip"),
    password: lsGet("mdc_pw"),
    error: "",
    showCertLink: false,
    connecting: false,
    path: [] as string[],     // selected [year, month, day, hour] prefix
    list: [] as string[],     // child folder names at the current level
    hourGops: [] as GopEntry[],
    playWall: 0,              // current playhead as wall-clock ms
}, undefined, { deep: false });

const LEVELS = ["Year", "Month", "Day", "Hour"];
let api: CameraApi | undefined;
let player: Player | undefined;
let videoEl: HTMLVideoElement | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

async function connect(): Promise<void> {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
    runInAction(() => { state.error = ""; state.showCertLink = false; state.connecting = true; });
    try {
        api = new CameraApi(state.ip.trim());
        await api.connect(state.password);
        lsSet("mdc_ip", state.ip.trim());
        lsSet("mdc_pw", state.password);
        runInAction(() => { state.view = "browse"; });
        await navigateTo(getUrlPath(), false); // restore the drilled-in location from the URL
    } catch (e: any) {
        runInAction(() => { state.error = e?.message || String(e); state.showCertLink = !!e?.needsCert; });
        // Only the connection error is transient (cert not accepted yet) — keep
        // retrying so it connects the instant they accept it. Never retry a
        // wrong password / blacklist.
        if (e?.needsCert) retryTimer = setTimeout(() => void connect(), 2000);
    } finally {
        runInAction(() => { state.connecting = false; });
    }
}

// Navigation lives in the URL (?at=YYYY/MM/DD/HH) so refresh, share, and the
// browser back/forward buttons all preserve where you've drilled in.
function setUrlPath(parts: string[]): void {
    const at = parts.join("/");
    try { history.pushState({}, "", at ? `?at=${at}` : location.pathname); } catch { /* ignore */ }
}
function getUrlPath(): string[] {
    try { return (new URLSearchParams(location.search).get("at") || "").split("/").filter(Boolean); }
    catch { return []; }
}

// Central navigation: load the right data for `parts`, update state, and (unless
// we're responding to a popstate) push the new URL.
async function navigateTo(parts: string[], push = true): Promise<void> {
    if (!api) return;
    if (push) setUrlPath(parts);
    if (parts.length === 4) {
        const gops = await api.getHourIndex(parts);
        runInAction(() => { state.path = parts; state.hourGops = gops; state.playWall = gops.length ? gops[0].t : 0; });
        setTimeout(() => startPlayer(parts, gops), 0); // wait for <video> to mount
    } else {
        const list = await api.listChildren(parts);
        runInAction(() => { state.path = parts; state.list = list; state.hourGops = []; });
        teardownPlayer();
    }
}

function descend(name: string): void { void navigateTo([...state.path, name]); }
function gotoLevel(depth: number): void { void navigateTo(state.path.slice(0, depth)); }

function startPlayer(path: string[], gops: GopEntry[]): void {
    if (!api || !videoEl || !gops.length) return;
    teardownPlayer();
    player = new Player(videoEl, api, path, gops);
    videoEl.ontimeupdate = () => { if (player) runInAction(() => { state.playWall = player!.hourStart + videoEl!.currentTime * 1000; }); };
    void player.seek(gops[0].t);
}

function teardownPlayer(): void { if (player) { player.teardown(); player = undefined; } }

function fmtClock(ms: number): string { return new Date(ms).toLocaleTimeString(); }
function pad(n: number): string { return String(n).padStart(2, "0"); }

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

const BrowseView = observer(class extends preact.Component { render() {
    const atHour = state.path.length === 4 && state.hourGops.length > 0;
    return (
        <div className={css.vbox(16).width("100%").maxWidth(900)}>
            {/* breadcrumb */}
            <div className={css.hbox(8).fontSize(14)}>
                <span className={css.pointer.color("hsl(210,90%,70%)")} onClick={() => void gotoLevel(0)}>All</span>
                {state.path.map((p, i) => (
                    <span key={i} className={css.hbox(8)}>
                        <span className={css.opacity(0.5)}>/</span>
                        <span className={css.pointer.color("hsl(210,90%,70%)")} onClick={() => void gotoLevel(i + 1)}>{p}</span>
                    </span>
                ))}
            </div>

            {!atHour && (
                <div className={css.vbox(8)}>
                    <div className={css.fontSize(12).opacity(0.7)}>Select {LEVELS[state.path.length] || "item"}</div>
                    <div className={css.hbox(8).wrap}>
                        {state.list.length === 0 && <div className={css.opacity(0.5)}>No footage here yet.</div>}
                        {state.list.map(name => (
                            <button key={name} className={chipCss} onClick={() => void descend(name)}>{name}</button>
                        ))}
                    </div>
                </div>
            )}

            {atHour && <PlayerView />}
        </div>
    );
} });

const PlayerView = observer(class extends preact.Component { render() {
    const start = state.hourGops.length ? state.hourGops[0].t : 0;
    const durSec = player ? player.durationSec() : 0;
    const posSec = Math.max(0, (state.playWall - start) / 1000);
    return (
        <div className={css.vbox(10).width("100%")}>
            <video ref={(el: any) => { videoEl = el; }} className={css.width("100%").background("#000").maxHeight("70vh")}
                controls playsInline muted />
            <div className={css.hbox(10).alignItems("center")}>
                <span className={css.fontSize(12).opacity(0.8).width(96)}>{fmtClock(state.playWall)}</span>
                <input type="range" className={css.flexGrow(1)} min={0} max={Math.max(1, Math.floor(durSec))} step={1}
                    value={Math.floor(posSec)}
                    onInput={e => { const v = Number((e.target as HTMLInputElement).value); if (player) void player.seek(start + v * 1000); }} />
                <span className={css.fontSize(12).opacity(0.6).width(110)}>{pad(Math.floor(durSec / 60))}:{pad(Math.floor(durSec % 60))} total</span>
            </div>
            <div className={css.fontSize(12).opacity(0.6)}>{state.hourGops.length} segments · {Math.round(durSec)}s of footage</div>
        </div>
    );
} });

const App = observer(class extends preact.Component {
    render() {
        return (
            <div className={css.vbox(20).alignItems("center").minHeight("100vh").pad2(36, 20)}>
                {state.view === "connect" ? <ConnectView /> : <BrowseView />}
                <div className={css.fontSize(11).opacity(0.4)}>Build {BUILD_TIMESTAMP}</div>
            </div>
        );
    }
});

const inputCss = css.fontSize(15).pad2(10, 12).hsl(220, 15, 16).color("inherit").border("1px solid hsl(220,15%,30%)").width("100%").toString();
const btnCss = css.fontSize(15).pad2(10, 18).hsl(220, 90, 55).color("white").border("none").pointer.toString();
const chipCss = css.fontSize(15).pad2(8, 16).hsl(220, 15, 18).color("inherit").border("1px solid hsl(220,15%,30%)").pointer.toString();

function main(): void {
    configureMobxNextFrameScheduler();
    preact.render(<App />, document.getElementById("app")!);
    // Back/forward navigates the drill path (which lives in ?at=).
    window.addEventListener("popstate", () => { if (state.view === "browse" && api) void navigateTo(getUrlPath(), false); });
    // Auto-connect on revisit if we already know the IP + password (and the cert
    // was accepted before). Falls back to the connect screen on failure.
    if (state.ip.trim() && state.password.trim()) void connect();
}
if (!isNode()) main();
