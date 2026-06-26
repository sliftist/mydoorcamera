import * as preact from "preact";
import { runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { formatDateTime } from "socket-function/src/formatting/format";
import { state } from "../helpers/appState";
import { saveUrlPosition } from "../helpers/navigation";
import { setLoopRegion } from "../helpers/trackbarHelpers";
import { computeRegions, regionsGopCount, ActivityRegion } from "../helpers/activityRegions";
import { getThumbUrl } from "../helpers/thumbnails";
import { navBtnCss } from "../helpers/styles";

const ROW_H = 64;       // fixed card height (px) — makes virtualization trivial
const OVERSCAN = 3;     // rows rendered beyond the viewport on each side

// Activity-region browser: collapsed by default, expands into a virtualized,
// scrollable list of region thumbnails. Shown above the date picker.
@observer
export class ActivityPanel extends preact.Component<{}, { scrollTop: number; viewportH: number }> {
    state = { scrollTop: 0, viewportH: 0 };
    private onScroll = (e: any) => { this.setState({ scrollTop: e.target.scrollTop, viewportH: e.target.clientHeight }); };
    private setScroller = (el: HTMLElement | null) => { if (el && !this.state.viewportH) this.setState({ viewportH: el.clientHeight }); };

    private toggle() {
        runInAction(() => { state.activityPanelOpen = !state.activityPanelOpen; });
        saveUrlPosition(state.playWall);
    }

    render() {
        if (!state.coverage || !state.index) return <div />;
        const headerCss = css.hbox(10).width("100%").alignItems("center").pad2(6, 8).hsl(220, 15, 14).border("1px solid hsl(220,15%,28%)");

        // Collapsed: NO region computation, no counts — just the label.
        if (!state.activityPanelOpen) {
            return (
                <div className={css.width("100%").maxWidth(1200)}>
                    <div className={headerCss} style={{ cursor: "pointer", boxSizing: "border-box" }} onClick={() => this.toggle()}>
                        <span style={{ fontSize: "13px" }}>▸ Activity</span>
                        <span className={css.flexGrow(1)} />
                        <span className={css.fontSize(11).opacity(0.45)}>click to expand</span>
                    </div>
                </div>
            );
        }

        // Expanded: compute regions for the current zoom window.
        const vs = state.viewStart || state.coverage.dayStartMs, ve = state.viewEnd || state.coverage.dayEndMs;
        const regions = computeRegions(state.index, state.activityThreshold, vs, ve);
        const header = (
            <div className={headerCss} style={{ cursor: "pointer", boxSizing: "border-box" }} onClick={() => this.toggle()}>
                <span style={{ fontSize: "13px" }}>▾ Activity</span>
                <span className={css.fontSize(12).opacity(0.7)}>{regions.length} section{regions.length === 1 ? "" : "s"} · {regionsGopCount(regions).toLocaleString()} GOPs</span>
                <span className={css.flexGrow(1)} />
                <span className={css.hbox(4).alignItems("center").opacity(0.7).fontSize(11)} onClick={(e: any) => e.stopPropagation()} title="Activity threshold — a GOP counts as activity when its value is at least this">
                    threshold
                    <input type="number" step="0.001" min="0" max="1" value={state.activityThreshold}
                        onInput={(e: any) => { const v = Number(e.target.value); runInAction(() => { state.activityThreshold = v >= 0 ? v : 0; }); saveUrlPosition(state.playWall); }}
                        style={{ width: "64px", fontSize: "11px", padding: "1px 4px", background: "hsl(220,15%,16%)", color: "inherit", border: "1px solid hsl(220,15%,30%)" }} />
                </span>
            </div>
        );

        const total = regions.length * ROW_H;
        const vh = this.state.viewportH || Math.round(window.innerHeight * 0.7);
        const first = Math.max(0, Math.floor(this.state.scrollTop / ROW_H) - OVERSCAN);
        const last = Math.min(regions.length, Math.ceil((this.state.scrollTop + vh) / ROW_H) + OVERSCAN);
        const cards: preact.JSX.Element[] = [];
        for (let i = first; i < last; i++) cards.push(this.card(regions[i], i));

        return (
            <div className={css.width("100%").maxWidth(1200).vbox(0)}>
                {header}
                <div ref={this.setScroller as any} onScroll={this.onScroll}
                    className={css.relative.width("100%").hsl(220, 15, 11).border("1px solid hsl(220,15%,28%)")}
                    style={{ maxHeight: "70vh", overflowY: "auto", boxSizing: "border-box", borderTop: "none" }}>
                    <div style={{ position: "relative", height: total + "px" }}>{cards}</div>
                </div>
            </div>
        );
    }

    private card(r: ActivityRegion, i: number): preact.JSX.Element {
        const url = getThumbUrl({ level: state.level, t: r.peak.t }); // undefined while loading, "" on failure
        const looped = state.loopStart === r.start && state.loopEnd === r.end;
        return (
            <div key={r.peak.t} onMouseDown={() => setLoopRegion(r.start, r.end)} title="Loop this activity region"
                className={css.hbox(10).alignItems("center").pad2(4, 8)}
                style={{ position: "absolute", top: (i * ROW_H) + "px", left: 0, right: 0, height: ROW_H + "px", boxSizing: "border-box", cursor: "pointer", borderBottom: "1px solid hsl(220,15%,18%)", background: looped ? "hsl(40,60%,18%)" : "transparent" }}>
                <div className={css.hsl(220, 15, 6)} style={{ width: "96px", height: "54px", flexShrink: 0, overflow: "hidden" }}>
                    {url ? <img src={url} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                        : <div className={css.fontSize(10).opacity(0.4)} style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>{url === "" ? "—" : "…"}</div>}
                </div>
                <div className={css.vbox(2).flexGrow(1).minWidth(0).fontSize(12)}>
                    <span style={{ whiteSpace: "nowrap" }}>{formatDateTime(r.start)}</span>
                    <span className={css.fontSize(11).opacity(0.6)}>{r.gopCount} GOPs · peak {r.peak.aMax.toFixed(4)}</span>
                </div>
                <button className={navBtnCss} style={{ fontSize: "11px", padding: "2px 8px", flexShrink: 0 }}
                    onMouseDown={(e: any) => { e.stopPropagation(); setLoopRegion(r.start, r.end); }}>↻ loop</button>
            </div>
        );
    }
}
