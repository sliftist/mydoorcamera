import * as preact from "preact";
import { runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { formatDateTime } from "socket-function/src/formatting/format";
import { state } from "../helpers/appState";
import { api } from "../helpers/session";
import { fmtBytes, bps, formatStats } from "../helpers/format";
import { downloadDebugInfo } from "../helpers/playerLog";
import { BUILD_TIMESTAMP } from "../../buildVersion";
import { ConnectView } from "./ConnectView";
import { VideoPlayer } from "./VideoPlayer";

@observer
export class App extends preact.Component {
    render() {
        return (
            <preact.Fragment>
                {state.view === "connect"
                    ? <div className={css.vbox(0).alignItems("center")} style={{ minHeight: "100vh", justifyContent: "center", padding: "24px", boxSizing: "border-box" }}><ConnectView /></div>
                    : <VideoPlayer />}
                {/* Stats + build pinned bottom-right, unaffected by scrolling. */}
                <div style={{ position: "fixed", right: "8px", bottom: "6px", fontSize: "11px", color: "rgba(255,255,255,0.65)", textAlign: "right", background: "rgba(0,0,0,0.45)", padding: "3px 8px", pointerEvents: "none", lineHeight: "1.5", maxWidth: "92vw" }}>
                    {state.view === "browse" && !state.online && <div style={{ color: "hsl(40,95%,62%)" }}>● reconnecting…</div>}
                    {state.view === "browse" && <div>{state.stats?.control?.liveStreaming ? <span style={{ color: "hsl(0,80%,60%)", fontWeight: 700 }}>● LIVE · </span> : null}GOP {state.outstandingGops > 0 ? <span style={{ color: "hsl(45,95%,62%)" }}>{state.outstandingGops}→</span> : null}{state.loadedGops} · {fmtBytes(state.loadedBytes)} · {bps(state.loadRateBps)}</div>}
                    {state.stats && <div>{formatStats(state.stats)}</div>}
                    {/* Build line + controls (always-encode stress toggle + debug log download). The
                        overlay is pointerEvents:none, so each button re-enables clicks on itself. */}
                    <div className={css.hbox(8).alignItems("center")} style={{ justifyContent: "flex-end" }}>
                        {state.view === "browse" && state.stats && (() => {
                            const on = !!state.stats!.control?.alwaysEncode;
                            return (
                                <button title="Bypass activity-gating and encode EVERY GOP (stress test)"
                                    onClick={async () => {
                                        try { const r = await api?.setAlwaysEncode(!on); runInAction(() => { if (state.stats?.control) state.stats.control.alwaysEncode = r ? r.alwaysEncode : !on; }); } catch { /* */ }
                                    }}
                                    style={{ pointerEvents: "auto", cursor: "pointer", font: "inherit", fontSize: "11px", fontWeight: 700, color: "#fff", background: on ? "hsl(0,75%,46%)" : "hsl(265,70%,52%)", border: "1px solid rgba(255,255,255,0.45)", padding: "2px 7px" }}>
                                    {on ? "■ Stop always encoding" : "● Change to always encode"}
                                </button>
                            );
                        })()}
                        <button onClick={() => downloadDebugInfo()} title="Download playback state-machine log"
                            style={{ pointerEvents: "auto", cursor: "pointer", font: "inherit", fontSize: "11px", color: "inherit", background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.25)", padding: "1px 6px" }}>
                            ⤓ debug
                        </button>
                        <span>Build {formatDateTime(BUILD_TIMESTAMP)}</span>
                    </div>
                </div>
            </preact.Fragment>
        );
    }
}
