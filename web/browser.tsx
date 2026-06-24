// Storage setup MUST run before any other import initializes storage. Module
// init order is preserved through bundling, so we import only these two
// functions and call them immediately, ahead of every other import below.
import { setFileAPIKey, usePrivateFileSystem } from "sliftutils/storage/FileFolderAPI";
setFileAPIKey("mydoorcamera");
usePrivateFileSystem();

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { configureMobxNextFrameScheduler } from "sliftutils/render-utils/mobxTyped";
import { css, isNode } from "typesafecss";
import { BulkDatabase2 } from "sliftutils/storage/BulkDatabase2/BulkDatabase2";
import { BUILD_TIMESTAMP } from "../buildVersion";

// Persistent collections — survive page reloads via BulkDatabase2.
type VisitRow = { key: string; count: number };
const visits = new BulkDatabase2<VisitRow>("mydoorcamera_visits");

type NoteRow = { key: string; text: string; time: number };
const notes = new BulkDatabase2<NoteRow>("mydoorcamera_notes");

const draft = observable.box("");

async function addNote() {
    const text = draft.get().trim();
    if (!text) return;
    const now = Date.now();
    await notes.write({ key: String(now), text, time: now });
    runInAction(() => draft.set(""));
}

@observer
class App extends preact.Component {
    render() {
        const count = visits.getSingleFieldSync("global", "count");
        const rows = notes.getColumnSync("text") ?? [];
        const sorted = [...rows].sort((a, b) => Number(b.key) - Number(a.key));

        return (
            <div className={css.vbox(20).alignItems("center").minHeight("100vh").pad2(40, 20)}>
                <div className={css.vbox(14).width("100%").maxWidth(680)}>
                    <h1 className={css.fontSize(34)}>Hello from mydoorcamera 👋</h1>
                    <div className={css.fontSize(15).opacity(0.85)}>
                        Bundled from TypeScript by sliftutils <code>build-web</code>, persisting data with{" "}
                        <code>BulkDatabase2</code>.
                    </div>

                    <div className={css.fontSize(18)}>
                        You've loaded this page <b>{count ?? "…"}</b> time(s) — the counter persists across reloads.
                    </div>

                    <div className={css.hbox(8)}>
                        <input
                            className={css.fontSize(16).pad2(10, 12).flexGrow(1).minWidth(0)
                                .hsl(220, 15, 16).color("inherit").border("1px solid hsl(220,15%,30%)")}
                            placeholder="Leave a note…"
                            value={draft.get()}
                            onInput={e => runInAction(() => draft.set((e.target as HTMLInputElement).value))}
                            onKeyDown={e => { if (e.key === "Enter") void addNote(); }}
                        />
                        <button
                            className={css.fontSize(16).pad2(10, 18).hsl(220, 90, 55).color("white")
                                .border("none").pointer}
                            onClick={() => void addNote()}
                        >
                            Add note
                        </button>
                    </div>

                    <div className={css.vbox(6)}>
                        {sorted.length === 0
                            ? <div className={css.opacity(0.5)}>No notes yet — add one, then reload to see it persist.</div>
                            : sorted.map(r => (
                                <div key={r.key} className={css.hbox(0).pad2(8, 12).hsl(220, 15, 15)
                                    .border("1px solid hsl(220,15%,24%)")}>
                                    {r.value}
                                </div>
                            ))}
                    </div>

                    <div className={css.fontSize(12).opacity(0.5)}>Build: {BUILD_TIMESTAMP}</div>
                </div>
            </div>
        );
    }
}

// Browser-only entry. The bundler evaluates this module in Node, so guard any
// top-level use of browser globals (document, etc.) behind isNode().
function main() {
    configureMobxNextFrameScheduler();

    // Count this page load.
    void (async () => {
        const current = (await visits.getSingleField("global", "count")) ?? 0;
        await visits.write({ key: "global", count: current + 1 });
    })();

    preact.render(<App />, document.getElementById("app")!);
}

if (!isNode()) main();
