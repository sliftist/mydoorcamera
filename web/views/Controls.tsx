import * as preact from "preact";
import { runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { state } from "../helpers/appState";
import { player, enterLive } from "../helpers/session";
import { saveUrlPosition, selectPeriod } from "../helpers/navigation";
import { statusLabel, statusColor, speedLabel, SPEEDS } from "../helpers/format";
import { playBtnCss, selectCss, liveBtnCss } from "../helpers/styles";

@observer
export class Controls extends preact.Component {
    render() {
        const playing = state.playStatus === "playing";
        return (
            <div className={css.hbox(8).alignItems("center")}>
                <button className={playBtnCss} title="Play/Pause (space)"
                    onMouseDown={(e: any) => { if (e.button !== 0) return; e.preventDefault(); player?.togglePlay(); }}>
                    {playing ? "❚❚" : "►"}
                </button>
                <span className={css.fontSize(13).width(110)} style={{ color: statusColor(state.playStatus) }}>{statusLabel(state.playStatus)}</span>
                <select className={selectCss} value={String(state.speed)}
                    onChange={(e: any) => { const s = Number(e.target.value); runInAction(() => { state.speed = s; }); player?.setSpeed(s); saveUrlPosition(state.playWall); }}>
                    {SPEEDS.map(s => <option key={s} value={String(s)}>{speedLabel(s)}×</option>)}
                </select>
                <button className={liveBtnCss} title="Seek to the latest recorded time (now)"
                    onMouseDown={(e: any) => { if (e.button !== 0) return; e.preventDefault(); void selectPeriod(Date.now(), true, Date.now()); }}>⇥ Now</button>
                <button className={liveBtnCss} title="Live stream (real-time)"
                    onMouseDown={(e: any) => { if (e.button !== 0) return; e.preventDefault(); void enterLive(); }}>● Live</button>
            </div>
        );
    }
}
