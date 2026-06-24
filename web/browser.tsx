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
    password: "",
    error: "",
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

async function connect(): Promise<void> {
    runInAction(() => { state.error = ""; state.connecting = true; });
    try {
        api = new CameraApi(state.ip.trim());
        await api.connect(state.password);
        lsSet("mdc_ip", state.ip.trim());
        const years = await api.listChildren([]);
        runInAction(() => { state.view = "browse"; state.path = []; state.list = years; state.hourGops = []; });
    } catch (e: any) {
        runInAction(() => { state.error = e?.message || String(e); });
    } finally {
        runInAction(() => { state.connecting = false; });
    }
}

async function descend(name: string): Promise<void> {
    if (!api) return;
    const path = [...state.path, name];
    if (path.length === 4) { await openHour(path); return; }
    const list = await api.listChildren(path);
    runInAction(() => { state.path = path; state.list = list; state.hourGops = []; });
    teardownPlayer();
}

async function gotoLevel(depth: number): Promise<void> {
    if (!api) return;
    const path = state.path.slice(0, depth);
    const list = await api.listChildren(path);
    runInAction(() => { state.path = path; state.list = list; state.hourGops = []; });
    teardownPlayer();
}

async function openHour(path: string[]): Promise<void> {
    if (!api) return;
    const gops = await api.getHourIndex(path);
    runInAction(() => { state.path = path; state.hourGops = gops; state.playWall = gops.length ? gops[0].t : 0; });
    setTimeout(() => startPlayer(path, gops), 0); // wait for <video> to mount
}

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
            {state.ip.trim() && (
                <div className={css.fontSize(12).opacity(0.8)}>
                    First time on this device? <a className={css.color("hsl(210,90%,70%)")} href={`https://${state.ip.trim()}:8443/`} target="_blank" rel="noreferrer">
                        open the certificate page</a> and accept the self-signed certificate, then come back.
                </div>
            )}
            <label className={css.vbox(4)}>
                <span className={css.fontSize(12).opacity(0.7)}>Password (4 words)</span>
                <input className={inputCss} type="password" placeholder="four words" value={state.password}
                    onInput={e => runInAction(() => { state.password = (e.target as HTMLInputElement).value; })}
                    onKeyDown={e => { if (e.key === "Enter") void connect(); }} />
            </label>
            <button className={btnCss} disabled={state.connecting || !state.ip.trim()} onClick={() => void connect()}>
                {state.connecting ? "Connecting…" : "Connect"}
            </button>
            {state.error && <div className={css.color("hsl(0,80%,70%)").fontSize(13)}>{state.error}</div>}
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
}
if (!isNode()) main();
