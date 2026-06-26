import * as preact from "preact";
import { runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { formatDateTime } from "socket-function/src/formatting/format";
import { state } from "../helpers/appState";
import { clockHMS } from "../helpers/format";
import { navBtnCss } from "../helpers/styles";
import { setTrackRef, onTrackDown, onTrackHover, onTrackLeave, resetZoom, clearLoopRegion, addLoopAtView, startLoopDrag, setLoopRegion } from "../helpers/trackbarHelpers";
import { computeRegions } from "../helpers/activityRegions";
import { saveUrlPosition, nudgeBucket } from "../helpers/navigation";
import { frameCount } from "../helpers/indexBuffer";
import { levelGopSpanSec, levelPeriod } from "../../src/config";

const TICKS = [0, 1, 2, 3, 4]; // label positions across the bar (fractions of /4), incl. both ends

@observer
export class Trackbar extends preact.Component {
    render() {
        const c = state.coverage;
        if (!c) return <div />;
        const vs = state.viewStart || c.dayStartMs, ve = state.viewEnd || c.dayEndMs;
        const span = Math.max(1, ve - vs);
        const fullSpan = c.dayEndMs - c.dayStartMs;
        const zoomed = span < fullSpan - 1000;
        const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
        const pct = (w: number) => (clamp01((w - vs) / span) * 100).toFixed(3) + "%";
        const wpct = (a: number, b: number) => ((clamp01((b - vs) / span) - clamp01((a - vs) / span)) * 100).toFixed(3) + "%";
        const inView = (a: number, b: number) => b > vs && a < ve;
        // Fixed-width flank (the prev/next buttons + matching spacers) so the marker
        // row and footer line up with the bar without hardcoded margin math.
        const flank: any = { flexBasis: "32px", flexShrink: 0, flexGrow: 0, boxSizing: "border-box" };
        return (
            <div className={css.vbox(4).width("100%")}>
                {/* Activity-sections row (only when the activity panel is expanded): one amber
                    segment per detected region; when segments get within a few px they MERGE
                    (rather than hide). Click a segment to loop that span. */}
                {state.activityPanelOpen && (() => {
                    const idx = state.index, widthPx = state.trackWidthPx;
                    if (!idx || !idx.length || !widthPx) return null;
                    const regions = computeRegions(idx, state.activityThreshold, vs, ve);
                    if (!regions.length) return null;
                    const segs = regions.map(r => ({ r, x0: clamp01((r.start - vs) / span) * widthPx, x1: clamp01((r.end - vs) / span) * widthPx }));
                    const merged: { x0: number; x1: number; s: number; e: number }[] = [];
                    for (const sg of segs) {
                        const last = merged[merged.length - 1];
                        if (last && sg.x0 - last.x1 < 3) { last.x1 = Math.max(last.x1, sg.x1); last.e = sg.r.end; }
                        else merged.push({ x0: sg.x0, x1: sg.x1, s: sg.r.start, e: sg.r.end });
                    }
                    return (
                        <div className={css.hbox(6).width("100%")}>
                            <div style={flank} />
                            <div className={css.relative.flexGrow(1).minWidth(0)} style={{ height: "6px" }}>
                                {merged.map((m, i) => (
                                    <div key={i} title="Loop this activity" onMouseDown={(e: any) => { e.stopPropagation(); setLoopRegion(m.s, m.e); }}
                                        style={{ position: "absolute", top: 0, bottom: 0, left: m.x0.toFixed(1) + "px", width: Math.max(2, m.x1 - m.x0 - 3).toFixed(1) + "px", background: "hsl(40,100%,55%)", cursor: "pointer" }} />
                                ))}
                            </div>
                            <div style={flank} />
                        </div>
                    );
                })()}
                {/* When zoomed enough that each GOP is wider than ~5px, mark them above
                    the bar: a line over each GOP's range with a 3px gap at the end. */}
                {(() => {
                    const idx = state.index, widthPx = state.trackWidthPx;
                    if (!idx || !idx.length || !widthPx) return null;
                    if ((levelGopSpanSec(state.level) * 1000 / span) * widthPx <= 5) return null;
                    const marks: any[] = [];
                    for (const g of idx) {
                        if (g.e <= vs || g.t >= ve) continue;
                        if (((g.e - g.t) / span) * widthPx <= 5) continue;
                        marks.push(<div key={g.t} style={{ position: "absolute", top: 0, bottom: 0, left: pct(g.t), width: `calc(${wpct(g.t, g.e)} - 3px)`, background: "hsl(210,45%,52%)" }} />);
                    }
                    return (
                        <div className={css.hbox(6).width("100%")}>
                            <div style={flank} />
                            <div className={css.relative.flexGrow(1).minWidth(0)} style={{ height: "3px" }}>{marks}</div>
                            <div style={flank} />
                        </div>
                    );
                })()}
                {/* Bar flanked by prev/next buttons that match the bar's height. */}
                <div className={css.hbox(6).width("100%").alignItems("stretch")}>
                <button className={navBtnCss} style={{ ...flank, padding: 0, fontSize: "16px", display: "flex", alignItems: "center", justifyContent: "center" }}
                    title={`Previous ${levelPeriod(state.level)} (or shift back)`} onClick={() => void nudgeBucket(-1)}>«</button>
                <div ref={setTrackRef as any}
                    className={css.relative.flexGrow(1).minWidth(0).height(56).hsl(220, 15, 12).border("1px solid hsl(220,15%,28%)")}
                    style={{ cursor: "pointer", userSelect: "none", overflow: "hidden", boxSizing: "border-box" }}
                    onMouseDown={onTrackDown}
                    onMouseMove={(e: any) => onTrackHover(e.clientX)}
                    onMouseLeave={onTrackLeave}>
                    {/* Has-footage: muted/translucent green. */}
                    {c.ranges.filter(r => inView(r.start, r.end)).map((r, i) => (
                        <div key={i} style={{ position: "absolute", top: 0, bottom: 0, left: pct(r.start), width: wpct(r.start, r.end), background: "rgba(80,200,120,0.20)" }} />
                    ))}
                    {/* Actually loaded into the player: solid green. */}
                    {state.bufferedRanges.filter(r => inView(r.start, r.end)).map((r, i) => (
                        <div key={"ld" + i} title="loaded into the player" style={{ position: "absolute", top: 0, bottom: 0, left: pct(r.start), width: wpct(r.start, r.end), background: "hsl(150,55%,38%)" }} />
                    ))}
                    {c.badRanges.filter(r => inView(r.start, r.end)).map((r, i) => (
                        <div key={"b" + i} title="conflicting / bad data" style={{ position: "absolute", top: 0, bottom: 0, left: pct(r.start), width: wpct(r.start, r.end), background: "repeating-linear-gradient(45deg, hsl(0,70%,42%), hsl(0,70%,42%) 6px, hsl(0,70%,26%) 6px, hsl(0,70%,26%) 12px)" }} />
                    ))}
                    {/* Activity line chart (yellow). Sampled at the current zoom window's
                        resolution (re-fetched on zoom) so zooming in reveals per-GOP detail. */}
                    {(() => {
                        const va = state.viewActivity;
                        const act = va ? va.activity : (c.activity || []);
                        const from = va ? va.fromMs : c.dayStartMs, to = va ? va.toMs : c.dayEndMs;
                        if (!act.length) return null;
                        const scale = Math.max(0.05, ...act, 0);
                        const bucketMs = (to - from) / act.length;
                        const pts: string[] = [];
                        for (let i = 0; i < act.length; i++) {
                            const xf = (from + i * bucketMs - vs) / span;
                            if (xf < -0.02 || xf > 1.02) continue;
                            pts.push(`${(xf * 1000).toFixed(1)},${(100 - Math.pow(Math.min(1, act[i] / scale), state.activityExp) * 100).toFixed(1)}`);
                        }
                        return (
                            <svg viewBox="0 0 1000 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
                                <polyline points={pts.join(" ")} fill="none" stroke="hsl(50,100%,65%)" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.9} />
                            </svg>
                        );
                    })()}
                    {/* Thin gridlines only; the time labels live in a row beneath the bar. */}
                    {TICKS.map((k) => (
                        <div key={"tk" + k} style={{ position: "absolute", top: 0, bottom: 0, left: (k / 4 * 100).toFixed(2) + "%", width: "1px", background: "rgba(255,255,255,0.20)", pointerEvents: "none" }} />
                    ))}
                    {/* Playhead lines live in the TOP quarter only, so they don't fight the activity chart. */}
                    <div style={{ position: "absolute", top: 0, height: "28%", left: pct(state.desiredWall), width: "2px", background: "hsl(265,90%,66%)" }} title="intended playback position" />
                    <div style={{ position: "absolute", top: 0, height: "28%", left: pct(state.playWall), width: "2px", background: "hsl(210,100%,66%)" }} title="actual playback position" />
                    {state.hoverWall != null && inView(state.hoverWall, state.hoverWall) && (
                        <div style={{ position: "absolute", top: 0, bottom: 0, left: pct(state.hoverWall), width: "1px", background: "rgba(255,255,255,0.6)" }}>
                            <div style={{ position: "absolute", bottom: "2px", transform: "translateX(-50%)", background: "#000", padding: "2px 6px", fontSize: "11px", whiteSpace: "nowrap", border: "1px solid hsl(220,15%,35%)" }}>{clockHMS(state.hoverWall)}</div>
                        </div>
                    )}
                    {/* Loop region: shaded band + two draggable handles (amber). */}
                    {!!(state.loopStart && state.loopEnd > state.loopStart && inView(state.loopStart, state.loopEnd)) && (
                        <preact.Fragment>
                            <div style={{ position: "absolute", top: 0, bottom: 0, left: pct(state.loopStart), width: wpct(state.loopStart, state.loopEnd), background: "rgba(255,180,0,0.12)", borderLeft: "1px solid rgba(255,180,0,0.5)", borderRight: "1px solid rgba(255,180,0,0.5)", pointerEvents: "none", boxSizing: "border-box" }} />
                            <div onMouseDown={(e: any) => startLoopDrag("start", e)} title="loop start" style={{ position: "absolute", top: 0, bottom: 0, left: pct(state.loopStart), width: "7px", marginLeft: "-3px", cursor: "ew-resize", background: "rgba(255,180,0,0.85)" }} />
                            <div onMouseDown={(e: any) => startLoopDrag("end", e)} title="loop end" style={{ position: "absolute", top: 0, bottom: 0, left: pct(state.loopEnd), width: "7px", marginLeft: "-4px", cursor: "ew-resize", background: "rgba(255,180,0,0.85)" }} />
                        </preact.Fragment>
                    )}
                </div>
                <button className={navBtnCss} style={{ ...flank, padding: 0, fontSize: "16px", display: "flex", alignItems: "center", justifyContent: "center" }}
                    title={`Next ${levelPeriod(state.level)} (or shift forward)`} onClick={() => void nudgeBucket(1)}>»</button>
                </div>
                {/* Time labels beneath the bar (no longer overlapping the activity chart / playhead). */}
                <div className={css.hbox(6).width("100%")}>
                    <div style={flank} />
                    <div className={css.relative.flexGrow(1).minWidth(0)} style={{ height: "11px" }}>
                        {TICKS.map((k, i) => {
                            const wall = vs + (k / 4) * span;
                            const lbl = i === 0 ? { left: "0", transform: "translateX(0)" }
                                : i === TICKS.length - 1 ? { left: "100%", transform: "translateX(-100%)" }
                                    : { left: (k / 4 * 100).toFixed(2) + "%", transform: "translateX(-50%)" };
                            return (
                                <div key={"tl" + k} style={{ position: "absolute", top: 0, ...lbl, fontSize: "9px", color: "rgba(255,255,255,0.7)", whiteSpace: "nowrap", pointerEvents: "none" }}>{formatDateTime(wall)}</div>
                            );
                        })}
                    </div>
                    <div style={flank} />
                </div>
                {/* Footer, aligned with the bar via matching flank spacers. */}
                <div className={css.hbox(6).width("100%")}>
                    <div style={flank} />
                    <div className={css.hbox(8).flexGrow(1).minWidth(0).fontSize(11).opacity(0.8).alignItems("center")} style={{ justifyContent: "space-between" }}>
                        <span style={{ whiteSpace: "nowrap", color: "hsl(265,90%,76%)" }}>{formatDateTime(state.hoverWall != null ? state.hoverWall : state.desiredWall)}</span>
                        {state.index && <span className={css.opacity(0.55)}>{frameCount(state.index, vs, ve).toLocaleString()} frames in view</span>}
                        <span className={css.hbox(4).alignItems("center").opacity(0.6)} title="Activity chart curve (gamma) — lower emphasizes small activity">
                            activity curve
                            <input type="number" step="0.05" min="0.05" max="3" value={state.activityExp}
                                onInput={(e: any) => { const v = Number(e.target.value) || 0.4; runInAction(() => { state.activityExp = v; }); saveUrlPosition(state.playWall); }}
                                style={{ width: "52px", fontSize: "11px", padding: "1px 4px", background: "hsl(220,15%,16%)", color: "inherit", border: "1px solid hsl(220,15%,30%)" }} />
                        </span>
                        {!!(state.loopStart && state.loopEnd > state.loopStart)
                            ? <button className={navBtnCss} style={{ fontSize: "11px", padding: "2px 8px", color: "hsl(40,100%,70%)" }} onClick={clearLoopRegion} title="Clear the loop">✕ loop</button>
                            : <button className={navBtnCss} style={{ fontSize: "11px", padding: "2px 8px" }} onClick={addLoopAtView} title="Loop the middle of the current view">↻ loop</button>}
                        {zoomed
                            ? <button className={navBtnCss} style={{ fontSize: "11px", padding: "2px 8px" }} onClick={resetZoom} title="Reset zoom (show the whole period)">⤢ reset zoom</button>
                            : <span className={css.opacity(0.5)}>scroll to zoom</span>}
                    </div>
                    <div style={flank} />
                </div>
            </div>
        );
    }
}
