import * as preact from "preact";
import { runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { Input } from "sliftutils/render-utils/Input";
import { css } from "typesafecss";
import { formatDateTime } from "socket-function/src/formatting/format";
import { state } from "../helpers/appState";
import { saveUrlPosition } from "../helpers/navigation";
import { goToActivity } from "../helpers/trackbarHelpers";
import { getSectionList, Section } from "../helpers/sections";
import { getThumbUrl } from "../helpers/thumbnails";
import { fmtDur } from "../helpers/format";

const CARD_W = 240;     // card width (px) — matches the 240px stored thumbnail resolution
const CARD_PAD = 6;     // inner padding around each card
const TEXT_H = 34;      // height reserved for the two text lines under a thumbnail
const OVERSCAN = 2;     // extra rows rendered beyond the viewport on each side
// Frames are 16:9; we reserve each card's thumbnail box at that aspect from the column
// width, so the grid has its exact size before any image loads (no shift, no cropping).

const durSum = (secs: Section[]) => secs.reduce((s, x) => s + (x.e - x.s) / 1000, 0);

// Activity-section browser: collapsed by default, expands into a virtualized, scrollable GRID of
// section thumbnails. Uses ONLY the recorded section list (start/end/peak/thumb) — never the
// per-frame index. The threshold just filters which sections show; it never re-segments them.
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
        if (!state.coverage) return <div />;
        const headerCss = css.hbox(10).width("100%").alignItems("center").pad2(6, 8).hsl(220, 15, 14).border("1px solid hsl(220,15%,28%)");

        // The recorded sections for the day (tiny list, reactive). "Total" = every recorded section;
        // the threshold filters this list by peak activity — it does NOT recompute the sections.
        const all = getSectionList({ fromMs: state.coverage.dayStartMs, toMs: state.coverage.dayEndMs, version: state.sectionsVersion }) || [];
        let sections = all.filter(x => x.a >= state.activityThreshold);
        if (state.activitySort === "peak") sections = [...sections].sort((a, b) => b.a - a.a);
        else sections = [...sections].sort((a, b) => a.s - b.s);
        const summary = `${sections.length} / ${all.length} sections | ${fmtDur(durSum(sections))} / ${fmtDur(durSum(all))}`;

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
                {/* Sort toggle — shows both states, highlights the active one. */}
                <div className={css.hbox(0)} onClick={(e: any) => e.stopPropagation()} style={{ border: "1px solid hsl(220,15%,32%)" }} title="Order activity events">
                    {(["time", "peak"] as const).map(m => (
                        <button key={m} onClick={() => { runInAction(() => { state.activitySort = m; }); saveUrlPosition(state.playWall); }}
                            style={{ pointerEvents: "auto", cursor: "pointer", font: "inherit", fontSize: "11px", padding: "2px 9px", border: "none",
                                color: state.activitySort === m ? "#fff" : "hsl(0,0%,58%)",
                                background: state.activitySort === m ? "hsl(210,55%,32%)" : "transparent" }}>
                            {m === "time" ? "chronological" : "peak"}
                        </button>
                    ))}
                </div>
                <span className={css.hbox(4).alignItems("center").opacity(0.7).fontSize(11)} onClick={(e: any) => e.stopPropagation()} title="Peak-activity threshold — an event shows when its peak is at least this">
                    threshold
                    {/* sliftutils <Input hot> preserves the raw text while focused, so typing "0.01"
                        isn't clobbered when the intermediate "0.0" parses back to 0. hot = live updates
                        per keystroke via onChangeValue. Never bind value to a re-parsed number yourself. */}
                    <Input hot type="number" step="0.01" min="0" max="1" value={state.activityThreshold}
                        onChangeValue={(v: string) => { const n = Number(v); if (!Number.isFinite(n)) return; runInAction(() => { state.activityThreshold = Math.min(1, Math.max(0, n)); }); saveUrlPosition(state.playWall); }}
                        style={{ width: "72px", fontSize: "11px", padding: "1px 4px", background: "hsl(220,15%,16%)", color: "inherit", border: "1px solid hsl(220,15%,30%)" }} />
                </span>
            </div>
        );

        const w = this.state.viewportW || Math.min(1200, window.innerWidth);
        const cols = Math.max(1, Math.floor(w / CARD_W));
        const cardWpx = w / cols;
        const thumbH = (cardWpx - CARD_PAD * 2) * 9 / 16; // 16:9 thumbnail box
        const cardH = Math.round(thumbH + TEXT_H + CARD_PAD * 2);
        const rows = Math.ceil(sections.length / cols);
        const total = rows * cardH;
        const vh = this.state.viewportH || Math.round(window.innerHeight * 0.7);
        const firstRow = Math.max(0, Math.floor(this.state.scrollTop / cardH) - OVERSCAN);
        const lastRow = Math.min(rows, Math.ceil((this.state.scrollTop + vh) / cardH) + OVERSCAN);
        const colW = 100 / cols; // percent
        const cards: preact.JSX.Element[] = [];
        for (let row = firstRow; row < lastRow; row++) {
            for (let c = 0; c < cols; c++) {
                const i = row * cols + c;
                if (i >= sections.length) break;
                cards.push(this.card(sections[i], row, c, colW, cardH, thumbH));
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

    private card(sec: Section, row: number, col: number, colW: number, cardH: number, thumbH: number): preact.JSX.Element {
        // The section carries its own thumbnail key (peak-frame time + peak activity) — fetch directly.
        const url = getThumbUrl({ t: sec.t, a: sec.a }); // undefined while loading, "" on failure/none
        const looped = state.loopStart === sec.s && state.loopEnd === sec.e;
        return (
            <div key={sec.s} onMouseDown={(e: any) => { if (e.button !== 0) return; void goToActivity(sec.s, sec.e, sec.t); }} title="Click to enter viewing mode, zoom in, and loop this activity"
                className={css.vbox(3)} style={{ position: "absolute", top: (row * cardH) + "px", left: (col * colW) + "%", width: colW + "%", height: cardH + "px", padding: CARD_PAD + "px", boxSizing: "border-box", cursor: "pointer" }}>
                <div className={css.hsl(220, 15, 6).relative} style={{ width: "100%", height: thumbH + "px", flexShrink: 0, overflow: "hidden", outline: looped ? "2px solid hsl(40,80%,55%)" : "1px solid hsl(220,15%,22%)", outlineOffset: "-1px" }}>
                    {url ? <img src={url} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
                        : <div className={css.fontSize(10).opacity(0.4)} style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>{url === "" ? "—" : "…"}</div>}
                </div>
                <div className={css.vbox(1).minWidth(0).fontSize(11)}>
                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{formatDateTime(sec.s)}</span>
                    <span className={css.fontSize(10).opacity(0.6)}>{fmtDur((sec.e - sec.s) / 1000)} · peak {sec.a.toFixed(4)}</span>
                </div>
            </div>
        );
    }
}
