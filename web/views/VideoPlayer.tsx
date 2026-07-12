import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { state } from "../helpers/appState";
import { player, setCanvasEl, exitLive } from "../helpers/session";
import { saveUrlPosition, markVideoStarted, enterViewing } from "../helpers/navigation";
import { playBtnCss } from "../helpers/styles";
import { Trackbar } from "./Trackbar";
import { Controls } from "./Controls";
import { DatePicker } from "./DatePicker";
import { LevelSelector } from "./LevelSelector";
import { ActivityPanel } from "./ActivityPanel";

@observer
export class VideoPlayer extends preact.Component {
    render() {
        // "Viewing mode" = the user engaged the video (play button / clicked an activity / live). Until
        // then a plain load shows ONLY the activity list + thumbnails — no index, trackbar, or video.
        const viewing = state.videoStarted || state.live;
        const noFootage = viewing && state.coverage && state.coverage.ranges.length === 0;
        return (
            <div className={css.vbox(14).width("100%").alignItems("center")}>
                {/* Gap so the fixed top-right info overlay doesn't cover the activity panel below it. */}
                {!state.live && <div style={{ height: "96px", flexShrink: 0 }} />}
                {/* Top of page: activity monitor, then the date control, then the player. */}
                {!state.live && <ActivityPanel />}
                {!state.live && <div className={css.fontSize(13).opacity(0.75)}>
                    {state.day ? state.day.replace(/\//g, "-") : "No period selected"}{noFootage ? " · no footage in this period" : ""}
                </div>}
                {!state.live && <DatePicker />}
                {viewing
                    ? <div id="mdc-player" className={css.vbox(10).width("100%").alignItems("center")}
                        style={{ padding: "8px 12px 0", boxSizing: "border-box", maxWidth: "100%" }}>
                        {/* Controls above the video. The review index loads async on entering viewing —
                            until it's in, show a lightweight "loading" line and DON'T mount the canvas
                            (a canvas mounting before ranges exist would build the player with no footage). */}
                        {state.live
                            ? <div className={css.hbox(14).alignItems("center").width("100%").maxWidth(1200)}>
                                <span className={css.color("hsl(0,85%,62%)").fontSize(15)}>● LIVE</span>
                                <button className={playBtnCss} onMouseDown={(e: any) => { if (e.button !== 0) return; e.preventDefault(); void exitLive(); }}>Exit Live</button>
                                <span className={css.flexGrow(1)} />
                            </div>
                            : state.index
                                ? <div className={css.vbox(8).width("100%").maxWidth(1200)}><LevelSelector /><Trackbar /><Controls /></div>
                                : <div className={css.fontSize(13).opacity(0.6).maxWidth(1200).width("100%")}>Loading video…</div>}
                        {/* Largest 16:9 box that fits the viewport, but capped so at least ~200px of vertical
                            space remains for the activity list / controls (never a full-viewport video). */}
                        {(state.live || state.index) && <canvas ref={(el: any) => setCanvasEl(el)}
                            style={{
                                width: "100%", maxWidth: "calc((100vh - 260px) * 16 / 9)", maxHeight: "calc(100vh - 260px)", aspectRatio: "16 / 9",
                                background: "#000", objectFit: "contain", cursor: "pointer",
                                outline: state.dropping ? "3px solid hsl(0,90%,55%)" : state.seeking ? "3px solid hsl(45,100%,60%)" : "none", outlineOffset: "-3px",
                            }}
                            onMouseDown={(e: any) => { if (e.button !== 0) return; e.preventDefault(); if (!state.live) { markVideoStarted(); player?.togglePlay(); saveUrlPosition(state.playWall); } }} />}
                    </div>
                    : <div className={css.vbox(8).alignItems("center")} style={{ padding: "20px 12px" }}>
                        {/* Activity-only default view: nothing video-related is loaded. This button enters
                            viewing mode (loads the index/trackbar/player) and jumps to the latest footage. */}
                        <button className={playBtnCss} style={{ fontSize: "20px", padding: "12px 28px" }}
                            onMouseDown={(e: any) => { if (e.button !== 0) return; e.preventDefault(); void enterViewing(); }}>▶ Play video</button>
                        <span className={css.fontSize(12).opacity(0.55)}>Loads the video for this day — or just click an activity above</span>
                    </div>}
            </div>
        );
    }
}
