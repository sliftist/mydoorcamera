import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { state } from "../helpers/appState";
import { setLevel, levelOptions } from "../helpers/navigation";
import { tpfLabel, fmtDur } from "../helpers/format";

// Always-visible horizontal selector of thinning levels (used constantly). Click
// a level to view at that time-per-frame; the active one is highlighted. The
// sub-label shows how far back that level currently reaches.
@observer
export class LevelSelector extends preact.Component {
    render() {
        const levels = levelOptions();
        return (
            <div className={css.hbox(6).width("100%")} style={{ flexWrap: "wrap" }}>
                {levels.map(l => {
                    const sel = state.level === l.level;
                    const heldSec = l.latestMs > l.earliestMs ? (l.latestMs - l.earliestMs) / 1000 : 0;
                    return (
                        <button key={l.level} onClick={() => void setLevel(l.level)}
                            className={css.vbox(2).pad2(6, 12).pointer}
                            style={{
                                color: "inherit", minWidth: "92px", textAlign: "left",
                                border: "1px solid " + (sel ? "hsl(210,85%,58%)" : "hsl(220,15%,28%)"),
                                background: sel ? "hsl(210,55%,24%)" : "hsl(220,15%,14%)",
                            }}>
                            <span className={css.fontSize(13)} style={{ fontWeight: 600 }}>{tpfLabel(l)}</span>
                            <span className={css.fontSize(10).opacity(0.7)}>{heldSec > 0 ? `holds ${fmtDur(heldSec)}` : "—"}</span>
                        </button>
                    );
                })}
            </div>
        );
    }
}
