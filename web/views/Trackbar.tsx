import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { formatDateTime } from "socket-function/src/formatting/format";
import { state } from "../helpers/appState";
import { clockHMS } from "../helpers/format";
import { navBtnCss } from "../helpers/styles";
import { setTrackRef, onTrackDown, onTrackHover, onTrackLeave, resetZoom } from "../helpers/trackbarHelpers";

const TICKS = [1, 2, 3, 4]; // interior label positions (fractions of /5)

@observer
export class Trackbar extends preact.Component {
    render() {
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
        return (
            <div className={css.vbox(4).width("100%")}>
                <div ref={setTrackRef as any}
                    className={css.relative.width("100%").height(56).hsl(220, 15, 12).border("1px solid hsl(220,15%,28%)")}
                    style={{ cursor: "pointer", userSelect: "none", overflow: "hidden" }}
                    onMouseDown={onTrackDown}
                    onMouseMove={(e: any) => onTrackHover(e.clientX)}
                    onMouseLeave={onTrackLeave}>
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
    }
}
