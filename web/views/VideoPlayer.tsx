import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { state } from "../helpers/appState";
import { player, setVideoEl, exitLive } from "../helpers/session";
import { saveUrlPosition } from "../helpers/navigation";
import { rateColor, rateLabel } from "../helpers/format";
import { playBtnCss } from "../helpers/styles";
import { Trackbar } from "./Trackbar";
import { Controls } from "./Controls";
import { Calendar } from "./Calendar";
import { LevelsPanel } from "./LevelsPanel";

@observer
export class VideoPlayer extends preact.Component {
    render() {
        const noFootage = state.coverage && state.coverage.ranges.length === 0;
        return (
            <div className={css.vbox(14).width("100%").alignItems("center")}>
                {/* Player fills the first viewport; the date picker is below the fold. */}
                <div className={css.vbox(10).width("100%").maxWidth(1200).alignItems("center")}
                    style={{ minHeight: "100vh", justifyContent: "center", padding: "8px 12px", boxSizing: "border-box" }}>
                    <video ref={(el: any) => setVideoEl(el)} playsInline muted
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
                {!state.live && <LevelsPanel />}
                <div style={{ height: "48px" }} />
            </div>
        );
    }
}
