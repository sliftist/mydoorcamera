import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { state } from "../helpers/appState";
import { player, setCanvasEl, exitLive } from "../helpers/session";
import { saveUrlPosition, markVideoStarted } from "../helpers/navigation";
import { playBtnCss } from "../helpers/styles";
import { Trackbar } from "./Trackbar";
import { Controls } from "./Controls";
import { DatePicker } from "./DatePicker";
import { LevelSelector } from "./LevelSelector";
import { ActivityPanel } from "./ActivityPanel";

@observer
export class VideoPlayer extends preact.Component {
    render() {
        const noFootage = state.coverage && state.coverage.ranges.length === 0;
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
                <div className={css.vbox(10).width("100%").alignItems("center")}
                    style={{ minHeight: "100vh", justifyContent: "center", padding: "8px 12px", boxSizing: "border-box" }}>
                    {/* Controls above the video. */}
                    {state.live
                        ? <div className={css.hbox(14).alignItems("center").width("100%").maxWidth(1200)}>
                            <span className={css.color("hsl(0,85%,62%)").fontSize(15)}>● LIVE</span>
                            <button className={playBtnCss} onMouseDown={(e: any) => { if (e.button !== 0) return; e.preventDefault(); void exitLive(); }}>Exit Live</button>
                            <span className={css.flexGrow(1)} />
                        </div>
                        : state.coverage
                            ? <div className={css.vbox(8).width("100%").maxWidth(1200)}><LevelSelector /><Trackbar /><Controls /></div>
                            : <div className={css.width("100%").maxWidth(1200)}><LevelSelector /></div>}
                    {/* Largest 16:9 box that fits the viewport: width fills the screen, capped by the
                        available height so it never overflows — no artificial 1200px limit. */}
                    <canvas ref={(el: any) => setCanvasEl(el)}
                        style={{
                            width: "100%", maxWidth: "calc((100vh - 150px) * 16 / 9)", maxHeight: "calc(100vh - 150px)", aspectRatio: "16 / 9",
                            background: "#000", objectFit: "contain", cursor: "pointer",
                            outline: state.dropping ? "3px solid hsl(0,90%,55%)" : state.seeking ? "3px solid hsl(45,100%,60%)" : "none", outlineOffset: "-3px",
                        }}
                        onMouseDown={(e: any) => { if (e.button !== 0) return; e.preventDefault(); if (!state.live) { markVideoStarted(); player?.togglePlay(); saveUrlPosition(state.playWall); } }} />
                </div>
                <div style={{ height: "48px" }} />
            </div>
        );
    }
}
