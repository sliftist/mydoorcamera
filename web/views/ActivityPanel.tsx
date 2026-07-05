import * as preact from "preact";
import { runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { formatDateTime } from "socket-function/src/formatting/format";
import { state } from "../helpers/appState";
import { saveUrlPosition } from "../helpers/navigation";
import { goToActivity } from "../helpers/trackbarHelpers";
import { computeRegions, ActivityRegion } from "../helpers/activityRegions";
import { getThumbUrl, getThumbList } from "../helpers/thumbnails";
import { fmtDur } from "../helpers/format";

const TOTAL_THRESHOLD = 0.0001; // "total activity" = everything we recorded (the recorder's gate)

const CARD_W = 220;     // target card width (px) — column count derives from this
const CARD_PAD = 6;     // inner padding around each card
const TEXT_H = 34;      // height reserved for the two text lines under a thumbnail
const OVERSCAN = 2;     // extra rows rendered beyond the viewport on each side
// Frames are 16:9; we reserve each card's thumbnail box at that aspect from the column
// width, so the grid has its exact size before any image loads (no shift, no cropping).

// Activity-region browser: collapsed by default, expands into a virtualized,
// scrollable GRID of region thumbnails. Shown above the date picker. Clicking a
// card immediately seeks to that region and loops it (no separate loop button).
@observer
export class ActivityPanel extends preact.Component<{}, { scrollTop: number; viewportH: number; viewportW: number }> {
    state = { scrollTop: 0, viewportH: 0, viewportW: 0 };
    private onScroll = (e: any) => { this.setState({ scrollTop: e.target.scrollTop, viewportH: e.target.clientHeight, viewportW: e.target.clientWidth }); };
    private setScroller = (el: HTMLElement | null) => { if (el && (!this.state.viewportH || el.clientWidth !== this.state.viewportW)) this.setState({ viewportH: el.clientHeight, viewportW: el.clientWidth }); };

    private toggle() {
        runInAction(() => { state.activityPanelOpen = !state.activityPanelOpen; });
        saveUrlPosition(state.playWall);
    }

    render() {
        if (!state.coverage || !state.index) return <div />;
        const headerCss = css.hbox(10).width("100%").alignItems("center").pad2(6, 8).hsl(220, 15, 14).border("1px solid hsl(220,15%,28%)");

        // Region detection is cheap (a single pass over the index), so compute it
        // whether collapsed or expanded — the count is shown in both states.
        const regions = computeRegions(state.index, state.activityThreshold, state.coverage.dayStartMs, state.coverage.dayEndMs);
        regions.sort((a, b) => b.peak.aMax - a.peak.aMax); // highest peak first
        // "Total" = all recorded activity (threshold ~0); the summary shows filtered / total.
        const totalRegions = computeRegions(state.index, TOTAL_THRESHOLD, state.coverage.dayStartMs, state.coverage.dayEndMs);
        const durOf = (rs: ActivityRegion[]) => rs.reduce((s, r) => s + (r.endWall - r.startWall) / 1000, 0);
        const summary = `${regions.length} / ${totalRegions.length} sections | ${fmtDur(durOf(regions))} / ${fmtDur(durOf(totalRegions))}`;

        // Collapsed: show the label + section count, no thumbnails/grid.
        if (!state.activityPanelOpen) {
            return (
                <div className={css.width("100%").maxWidth(1200)}>
                    <div className={headerCss} style={{ cursor: "pointer", boxSizing: "border-box" }} onClick={() => this.toggle()}>
                        <span style={{ fontSize: "13px" }}>▸ Activity</span>
                        <span className={css.fontSize(12).opacity(0.7)}>{summary}</span>
                        <span className={css.flexGrow(1)} />
                        <span className={css.fontSize(11).opacity(0.45)}>click to expand</span>
                    </div>
                </div>
            );
        }
        const header = (
            <div className={headerCss} style={{ cursor: "pointer", boxSizing: "border-box" }} onClick={() => this.toggle()}>
                <span style={{ fontSize: "13px" }}>▾ Activity</span>
                <span className={css.fontSize(12).opacity(0.7)}>{summary}</span>
                <span className={css.flexGrow(1)} />
                <span className={css.hbox(4).alignItems("center").opacity(0.7).fontSize(11)} onClick={(e: any) => e.stopPropagation()} title="Peak-activity threshold — an event shows when its peak is at least this">
                    threshold
                    <input type="number" step="0.01" min="0" max="1" value={state.activityThreshold}
                        onInput={(e: any) => { const v = Number(e.target.value); runInAction(() => { state.activityThreshold = v >= 0 ? v : 0; }); saveUrlPosition(state.playWall); }}
                        style={{ width: "72px", fontSize: "11px", padding: "1px 4px", background: "hsl(220,15%,16%)", color: "inherit", border: "1px solid hsl(220,15%,30%)" }} />
                </span>
            </div>
        );

        const w = this.state.viewportW || Math.min(1200, window.innerWidth);
        const cols = Math.max(1, Math.floor(w / CARD_W));
        const cardWpx = w / cols;
        const thumbH = (cardWpx - CARD_PAD * 2) * 9 / 16; // 16:9 thumbnail box
        const cardH = Math.round(thumbH + TEXT_H + CARD_PAD * 2);
        const rows = Math.ceil(regions.length / cols);
        const total = rows * cardH;
        const vh = this.state.viewportH || Math.round(window.innerHeight * 0.7);
        const firstRow = Math.max(0, Math.floor(this.state.scrollTop / cardH) - OVERSCAN);
        const lastRow = Math.min(rows, Math.ceil((this.state.scrollTop + vh) / cardH) + OVERSCAN);
        const colW = 100 / cols; // percent
        // Pre-rendered thumbnails for the period (reactive — undefined while loading).
        const thumbs = getThumbList({ fromMs: state.coverage.dayStartMs, toMs: state.coverage.dayEndMs }) || [];
        const cards: preact.JSX.Element[] = [];
        for (let row = firstRow; row < lastRow; row++) {
            for (let c = 0; c < cols; c++) {
                const i = row * cols + c;
                if (i >= regions.length) break;
                cards.push(this.card(regions[i], row, c, colW, cardH, thumbH, thumbs));
            }
        }

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

    private card(r: ActivityRegion, row: number, col: number, colW: number, cardH: number, thumbH: number, thumbs: { t: number; a: number }[]): preact.JSX.Element {
        // The recorder pre-rendered a thumbnail per activity section; match this region to the one
        // whose peak-frame time lands inside it (nearest to the region's own peak).
        let th: { t: number; a: number } | null = null, bestD = Infinity;
        for (const x of thumbs) { if (x.t < r.startWall || x.t > r.endWall) continue; const d = Math.abs(x.t - r.peakWall); if (d < bestD) { bestD = d; th = x; } }
        const url = th ? getThumbUrl({ t: th.t, a: th.a }) : ""; // undefined while loading, "" on failure/none
        const looped = state.loopStart === r.startWall && state.loopEnd === r.endWall;
        return (
            <div key={r.peak.t} onMouseDown={(e: any) => { if (e.button !== 0) return; goToActivity(r.startWall, r.endWall, r.peakWall); }} title="Click to zoom in and loop this activity region"
                className={css.vbox(3)} style={{ position: "absolute", top: (row * cardH) + "px", left: (col * colW) + "%", width: colW + "%", height: cardH + "px", padding: CARD_PAD + "px", boxSizing: "border-box", cursor: "pointer" }}>
                <div className={css.hsl(220, 15, 6).relative} style={{ width: "100%", height: thumbH + "px", flexShrink: 0, overflow: "hidden", outline: looped ? "2px solid hsl(40,80%,55%)" : "1px solid hsl(220,15%,22%)", outlineOffset: "-1px" }}>
                    {url ? <img src={url} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
                        : <div className={css.fontSize(10).opacity(0.4)} style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>{url === "" ? "—" : "…"}</div>}
                </div>
                <div className={css.vbox(1).minWidth(0).fontSize(11)}>
                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{formatDateTime(r.startWall)}</span>
                    <span className={css.fontSize(10).opacity(0.6)}>{fmtDur((r.endWall - r.startWall) / 1000)} ({r.frameCount} frame{r.frameCount === 1 ? "" : "s"}) · peak {r.peak.aMax.toFixed(4)}</span>
                </div>
            </div>
        );
    }
}
