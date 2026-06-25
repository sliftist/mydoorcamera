import * as preact from "preact";
import { runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { state } from "../helpers/appState";
import { selectPeriod, periodKey, periodHasFootage } from "../helpers/navigation";
import { navBtnCss } from "../helpers/styles";
import { levelPeriod } from "../../src/config";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Move the picker view by `delta` units (months for day-picking, years for
// month-picking, 12-year pages for year-picking).
function shiftPicker(delta: number): void {
    const d = new Date(state.pickerAnchorMs || Date.now());
    const p = levelPeriod(state.level);
    const nd = p === "day" ? new Date(d.getFullYear(), d.getMonth() + delta, 1)
        : p === "month" ? new Date(d.getFullYear() + delta, 0, 1)
            : new Date(d.getFullYear() + delta * 12, 0, 1);
    runInAction(() => { state.pickerAnchorMs = nd.getTime(); });
}

// A single selectable cell. Green when it has footage, blue ring when selected —
// both can show at once, so you can always tell a selected period's footage.
function cell(key: string | number, label: any, startMs: number, level: number, opts: { wide?: boolean } = {}): preact.JSX.Element {
    const has = periodHasFootage(level, startMs);
    const sel = state.day === periodKey(level, startMs);
    return (
        <div key={key} className={css.fontSize(13).pad2(opts.wide ? 10 : 7, 0).pointer}
            style={{
                textAlign: "center",
                background: has ? "hsl(150,40%,26%)" : "transparent",
                border: sel ? "2px solid hsl(265,85%,66%)" : "2px solid transparent",
                color: has || sel ? "#fff" : "hsl(0,0%,45%)",
            }}
            onClick={() => void selectPeriod(startMs)}>{label}</div>
    );
}

@observer
export class DatePicker extends preact.Component {
    render() {
        const p = levelPeriod(state.level);
        const a = new Date(state.pickerAnchorMs || Date.now());
        const header = (title: string) => (
            <div className={css.hbox(10).alignItems("center")} style={{ justifyContent: "space-between" }}>
                <button className={navBtnCss} onClick={() => shiftPicker(-1)}>‹</button>
                <span className={css.fontSize(14)}>{title}</span>
                <button className={navBtnCss} onClick={() => shiftPicker(1)}>›</button>
            </div>
        );
        const grid = (cols: number, children: any) => <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: "4px" }}>{children}</div>;

        let body: any, hint: string;
        if (p === "day") {
            const y = a.getFullYear(), m = a.getMonth();
            const firstWd = new Date(y, m, 1).getDay();
            const numDays = new Date(y, m + 1, 0).getDate();
            const cells: any[] = [];
            for (let i = 0; i < firstWd; i++) cells.push(<div key={"e" + i} />);
            for (let dd = 1; dd <= numDays; dd++) cells.push(cell(dd, dd, new Date(y, m, dd).getTime(), 0));
            hint = "Pick a day.";
            body = <preact.Fragment>
                {header(new Date(y, m, 1).toLocaleString([], { month: "long", year: "numeric" }))}
                {grid(7, [...WEEKDAYS.map((w, i) => <div key={"w" + i} className={css.fontSize(11).opacity(0.5)} style={{ textAlign: "center" }}>{w}</div>), ...cells])}
            </preact.Fragment>;
        } else if (p === "month") {
            const y = a.getFullYear();
            hint = "Pick a month.";
            body = <preact.Fragment>
                {header(String(y))}
                {grid(4, MONTHS.map((mo, i) => cell(mo, mo, new Date(y, i, 1).getTime(), state.level, { wide: true })))}
            </preact.Fragment>;
        } else {
            const base = Math.floor(a.getFullYear() / 12) * 12;
            const years = Array.from({ length: 12 }, (_, i) => base + i);
            hint = "Pick a year.";
            body = <preact.Fragment>
                {header(`${base}–${base + 11}`)}
                {grid(4, years.map(yr => cell(yr, yr, new Date(yr, 0, 1).getTime(), state.level, { wide: true })))}
            </preact.Fragment>;
        }

        const onCurrent = state.day === periodKey(state.level, Date.now());
        const nowLabel = p === "day" ? "today" : p === "month" ? "this month" : "this year";
        return (
            <div className={css.vbox(8).width("100%").maxWidth(340)}>
                {body}
                <div className={css.fontSize(11).opacity(0.5)}>Green = has footage · purple ring = selected. {hint}</div>
                {!onCurrent && (
                    <button className={navBtnCss} style={{ padding: "6px 12px" }}
                        onClick={() => void selectPeriod(Date.now(), true, Date.now())}>⤓ Jump to {nowLabel}</button>
                )}
            </div>
        );
    }
}
