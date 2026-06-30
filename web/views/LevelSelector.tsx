import * as preact from "preact";
import { runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { state } from "../helpers/appState";
import { setLevel, levelOptions, saveUrlPosition } from "../helpers/navigation";
import { player } from "../helpers/session";
import { tpfLabel, fmtDur } from "../helpers/format";

// Toggle whether playback skips over gaps (no recorded footage / no activity).
// Off (default) -> gaps play as a blank frame with a timestamp; On -> jump past them.
function toggleSkip(): void {
    const m = state.gapMode === "skip" ? "blank" : "skip";
    runInAction(() => { state.gapMode = m; });
    player?.setGapMode(m);
    saveUrlPosition(state.playWall);
}

// Always-visible horizontal selector of thinning levels (used constantly). Click
// a level to view at that time-per-frame; the active one is highlighted. The
// sub-label shows how far back that level currently reaches. A separate "Skip
// gaps" toggle sits ahead of the levels (styled like them, but clearly spaced).
@observer
export class LevelSelector extends preact.Component {
    render() {
        const levels = levelOptions();
        const skipOn = state.gapMode === "skip";
        return (
            <div className={css.hbox(20).width("100%").alignItems("flex-start")} style={{ flexWrap: "wrap" }}>
                <button onClick={toggleSkip} title="Toggle skipping over gaps with no footage/activity"
                    className={css.vbox(2).pad2(6, 12).pointer}
                    style={{
                        color: "inherit", minWidth: "92px", textAlign: "left",
                        border: "1px solid " + (skipOn ? "hsl(150,70%,45%)" : "hsl(220,15%,28%)"),
                        background: skipOn ? "hsl(150,45%,22%)" : "hsl(220,15%,14%)",
                    }}>
                    <span className={css.fontSize(13)} style={{ fontWeight: 600 }}>Skip gaps</span>
                    <span className={css.fontSize(10).opacity(0.7)}>{skipOn ? "on" : "off"}</span>
                </button>
                <div className={css.hbox(6).flexGrow(1).minWidth(0)} style={{ flexWrap: "wrap" }}>
                {levels.map(l => {
                    const sel = state.level === l.level;
                    const heldSec = l.latestMs > l.earliestMs ? (l.latestMs - l.earliestMs) / 1000 : 0;
                    // Project how long this level COULD hold at its byte budget, by scaling
                    // the currently-held duration by budget/used.
                    const capSec = l.usedBytes > 0 && l.budgetBytes > 0 ? heldSec * (l.budgetBytes / l.usedBytes) : 0;
                    return (
                        <button key={l.level} onClick={() => void setLevel(l.level)}
                            className={css.vbox(2).pad2(6, 12).pointer}
                            style={{
                                color: "inherit", minWidth: "92px", textAlign: "left",
                                border: "1px solid " + (sel ? "hsl(210,85%,58%)" : "hsl(220,15%,28%)"),
                                background: sel ? "hsl(210,55%,24%)" : "hsl(220,15%,14%)",
                            }}>
                            <span className={css.fontSize(13)} style={{ fontWeight: 600 }}>{tpfLabel(l)}</span>
                            <span className={css.fontSize(10).opacity(0.7)}>{heldSec > 0 ? `${fmtDur(heldSec)} / ${capSec > 0 ? fmtDur(capSec) : "—"}` : "—"}</span>
                        </button>
                    );
                })}
                </div>
            </div>
        );
    }
}
