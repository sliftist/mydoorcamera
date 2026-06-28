import * as preact from "preact";
import { runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { state } from "../helpers/appState";
import { player, enterLive } from "../helpers/session";
import { saveUrlPosition } from "../helpers/navigation";
import { fmtDur, statusLabel, statusColor, speedLabel, SPEEDS } from "../helpers/format";
import { playBtnCss, selectCss, liveBtnCss } from "../helpers/styles";

@observer
export class Controls extends preact.Component {
    render() {
        const playing = state.playStatus === "playing";
        return (
            <div className={css.hbox(12).alignItems("center").width("100%")}>
                <button className={playBtnCss} title="Play/Pause (space)"
                    onMouseDown={(e: any) => { e.preventDefault(); player?.togglePlay(); }}>
                    {playing ? "❚❚" : "►"}
                </button>
                <span className={css.fontSize(13).width(110)} style={{ color: statusColor(state.playStatus) }}>{statusLabel(state.playStatus)}</span>
                <span className={css.fontSize(12).opacity(0.6).flexGrow(1)}>← → seek {fmtDur(5 * Math.pow(30, state.level))}</span>
                <span className={css.fontSize(13).opacity(0.7)}>⏩</span>
                <select className={selectCss} value={String(state.speed)}
                    onChange={(e: any) => { const s = Number(e.target.value); runInAction(() => { state.speed = s; }); player?.setSpeed(s); saveUrlPosition(state.playWall); }}>
                    {SPEEDS.map(s => <option key={s} value={String(s)}>{speedLabel(s)}×</option>)}
                </select>
                <select className={selectCss} value={state.gapMode} title="How playback crosses a gap with no recorded footage"
                    onChange={(e: any) => { const m = e.target.value === "skip" ? "skip" : "blank"; runInAction(() => { state.gapMode = m; }); player?.setGapMode(m); saveUrlPosition(state.playWall); }}>
                    <option value="blank">gaps: blank</option>
                    <option value="skip">gaps: skip</option>
                </select>
                <button className={liveBtnCss} title="Jump to live" onMouseDown={(e: any) => { e.preventDefault(); void enterLive(); }}>● Live</button>
            </div>
        );
    }
}
