import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { formatDateTime } from "socket-function/src/formatting/format";
import { state } from "../appState";
import { fmtBytes, bps, formatStats } from "../format";
import { BUILD_TIMESTAMP } from "../../buildVersion";
import { ConnectView } from "./ConnectView";
import { DayView } from "./DayView";

@observer
export class App extends preact.Component {
    render() {
        return (
            <preact.Fragment>
                {state.view === "connect"
                    ? <div className={css.vbox(0).alignItems("center")} style={{ minHeight: "100vh", justifyContent: "center", padding: "24px", boxSizing: "border-box" }}><ConnectView /></div>
                    : <DayView />}
                {/* Stats + build pinned bottom-right, unaffected by scrolling. */}
                <div style={{ position: "fixed", right: "8px", bottom: "6px", fontSize: "11px", color: "rgba(255,255,255,0.65)", textAlign: "right", background: "rgba(0,0,0,0.45)", padding: "3px 8px", pointerEvents: "none", lineHeight: "1.5", maxWidth: "92vw" }}>
                    {state.view === "browse" && !state.online && <div style={{ color: "hsl(40,95%,62%)" }}>● reconnecting…</div>}
                    {state.view === "browse" && <div>Loaded {fmtBytes(state.loadedBytes)} · {bps(state.loadRateBps)}</div>}
                    {state.stats && <div>{formatStats(state.stats)}</div>}
                    <div>Build {formatDateTime(BUILD_TIMESTAMP)}</div>
                </div>
            </preact.Fragment>
        );
    }
}
