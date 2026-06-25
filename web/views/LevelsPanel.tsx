import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { state } from "../appState";
import { setLevel } from "../navigation";
import { tpfLabel, fmtDur, gb } from "../format";

@observer
export class LevelsPanel extends preact.Component {
    render() {
        if (!state.levels.length) return <div />;
        return (
            <div className={css.vbox(6).width("100%").maxWidth(420)}>
                <div className={css.fontSize(12).opacity(0.7)}>Thinning levels — time per frame &amp; how far back each reaches (click to view)</div>
                {state.levels.map(l => {
                    const heldSec = l.latestMs > l.earliestMs ? (l.latestMs - l.earliestMs) / 1000 : 0;
                    const capSec = l.usedBytes > 0 ? heldSec * l.budgetBytes / l.usedBytes : 0;
                    const frac = l.budgetBytes > 0 ? Math.min(1, l.usedBytes / l.budgetBytes) : 0;
                    const sel = state.level === l.level;
                    return (
                        <div key={l.level} onClick={() => void setLevel(l.level)} className={css.vbox(3).pad2(6, 8).pointer}
                            style={{ background: sel ? "hsl(210,55%,20%)" : "hsl(220,15%,13%)", border: "1px solid " + (sel ? "hsl(210,80%,50%)" : "hsl(220,15%,24%)") }}>
                            <div className={css.hbox(8).fontSize(12).alignItems("baseline")} style={{ justifyContent: "space-between" }}>
                                <span style={{ fontWeight: 600 }}>{tpfLabel(l)}</span>
                                <span className={css.opacity(0.85)}>{heldSec > 0 ? `held ${fmtDur(heldSec)}` : "empty"}{capSec > 0 ? ` / ~${fmtDur(capSec)} capacity` : ""}</span>
                            </div>
                            <div style={{ position: "relative", height: "5px", background: "hsl(220,15%,22%)" }}>
                                <div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: (frac * 100).toFixed(1) + "%", background: sel ? "hsl(210,90%,58%)" : "hsl(150,45%,40%)" }} />
                            </div>
                            <div className={css.fontSize(10).opacity(0.5)}>{gb(l.usedBytes)} / {gb(l.budgetBytes)} GB</div>
                        </div>
                    );
                })}
            </div>
        );
    }
}
