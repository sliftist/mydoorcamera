import * as preact from "preact";
import { runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { state } from "../appState";
import { selectDay, thisMonth } from "../navigation";
import { pad2 } from "../format";
import { navBtnCss } from "../styles";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
function shiftMonth(delta: number): void {
    const [y, m] = state.calMonth.split("-").map(Number);
    const d = new Date(y, (m - 1) + delta, 1);
    runInAction(() => { state.calMonth = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; });
}

@observer
export class Calendar extends preact.Component {
    render() {
        const days = new Set(state.availableDays);
        const [y, m] = (state.calMonth || thisMonth()).split("-").map(Number);
        if (!y || !m) return <div />;
        const monthName = new Date(y, m - 1, 1).toLocaleString([], { month: "long", year: "numeric" });
        const firstWd = new Date(y, m - 1, 1).getDay();
        const numDays = new Date(y, m, 0).getDate();
        const cells: (number | null)[] = [];
        for (let i = 0; i < firstWd; i++) cells.push(null);
        for (let dd = 1; dd <= numDays; dd++) cells.push(dd);
        return (
            <div className={css.vbox(8).width("100%").maxWidth(340)}>
                <div className={css.hbox(10).alignItems("center")} style={{ justifyContent: "space-between" }}>
                    <button className={navBtnCss} onClick={() => shiftMonth(-1)}>‹</button>
                    <span className={css.fontSize(14)}>{monthName}</span>
                    <button className={navBtnCss} onClick={() => shiftMonth(1)}>›</button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: "4px" }}>
                    {WEEKDAYS.map((w, i) => <div key={"w" + i} className={css.fontSize(11).opacity(0.5)} style={{ textAlign: "center" }}>{w}</div>)}
                    {cells.map((dd, i) => {
                        if (dd == null) return <div key={i} />;
                        const key = `${y}/${pad2(m)}/${pad2(dd)}`;
                        const has = days.has(key);
                        const sel = state.day === key;
                        return (
                            <div key={i} className={css.fontSize(13).pad2(7, 0)}
                                style={{
                                    textAlign: "center", cursor: has ? "pointer" : "default",
                                    background: sel ? "hsl(210,90%,45%)" : (has ? "hsl(150,40%,26%)" : "transparent"),
                                    color: has || sel ? "#fff" : "hsl(0,0%,38%)",
                                }}
                                onClick={() => { if (has) void selectDay(key); }}>{dd}</div>
                        );
                    })}
                </div>
                <div className={css.fontSize(11).opacity(0.5)}>Green = has footage. Pick a day to scrub it above.</div>
            </div>
        );
    }
}
