import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { state } from "../helpers/appState";
import { player, setVideoEl, exitLive } from "../helpers/session";
import { saveUrlPosition, gotoBucket } from "../helpers/navigation";
import { rateColor, rateLabel } from "../helpers/format";
import { playBtnCss, navBtnCss } from "../helpers/styles";
import { levelPeriod } from "../../src/config";
import { Trackbar } from "./Trackbar";
import { Controls } from "./Controls";
import { DatePicker } from "./DatePicker";
import { LevelSelector } from "./LevelSelector";

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
                        style={{
                            width: "100%", maxWidth: "1200px", maxHeight: "calc(100vh - 150px)", aspectRatio: "16 / 9",
                            background: "#000", objectFit: "contain", cursor: "pointer",
                            // outline (not border) so it never shifts layout; shown while the seeked frame isn't rendered yet
                            outline: state.seeking ? "3px solid hsl(45,100%,60%)" : "none", outlineOffset: "-3px",
                        }}
                        onMouseDown={(e: any) => { e.preventDefault(); if (!state.live) { player?.togglePlay(); saveUrlPosition(state.playWall); } }} />
                    {state.live
                        ? <div className={css.hbox(14).alignItems("center").width("100%")}>
                            <span className={css.color("hsl(0,85%,62%)").fontSize(15)}>● LIVE</span>
                            <button className={playBtnCss} onMouseDown={(e: any) => { e.preventDefault(); void exitLive(); }}>Exit Live</button>
                            <span className={css.fontSize(13)} style={{ color: rateColor(state.playbackRate) }}>{rateLabel(state.playbackRate)}</span>
                            <span className={css.fontSize(13).opacity(0.8)}>buffered {state.bufferSec.toFixed(1)}s</span>
                        </div>
                        : state.coverage
                            ? <div className={css.vbox(8).width("100%")}>
                                <LevelSelector />
                                <div className={css.hbox(6).width("100%").alignItems("center")}>
                                    <button className={navBtnCss} title={`Previous ${levelPeriod(state.level)}`} onClick={() => void gotoBucket(-1)}>«</button>
                                    <div className={css.flexGrow(1).minWidth(0)}><Trackbar /></div>
                                    <button className={navBtnCss} title={`Next ${levelPeriod(state.level)}`} onClick={() => void gotoBucket(1)}>»</button>
                                </div>
                                <Controls />
                            </div>
                            : <LevelSelector />}
                </div>
                {!state.live && <div className={css.fontSize(13).opacity(0.75)}>
                    {state.day ? state.day.replace(/\//g, "-") : "No period selected"}{noFootage ? " · no footage in this period" : ""}
                </div>}
                {!state.live && <DatePicker />}
                <div style={{ height: "48px" }} />
            </div>
        );
    }
}
