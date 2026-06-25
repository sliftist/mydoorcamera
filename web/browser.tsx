// Entry point for the mydoorcamera browser app: wires global input handlers and
// renders <App />. All logic lives in the controller modules (session /
// navigation / trackbar) and the components under ./views.

import * as preact from "preact";
import { runInAction } from "mobx";
import { configureMobxNextFrameScheduler } from "sliftutils/render-utils/mobxTyped";
import { isNode } from "typesafecss";
import { state } from "./helpers/appState";
import { App } from "./views/App";
import { connect, player } from "./helpers/session";
import { selectPeriod, periodStartFromKey, getUrlDay, applyUrlZoom } from "./helpers/navigation";

// Arrow keys seek (step scaled by the level's time density, routed through the
// player's throttled seek-pump); space toggles play.
function onKeyDown(e: KeyboardEvent): void {
    if (state.view !== "browse" || !player || !state.coverage) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const base = state.desiredWall || player.currentWall();
        const viewSpan = (state.viewStart && state.viewEnd) ? (state.viewEnd - state.viewStart)
            : (state.coverage ? state.coverage.dayEndMs - state.coverage.dayStartMs : 60000);
        const step = viewSpan / 400; // 1/400th of the current trackbar zoom span
        const w = base + (e.key === "ArrowRight" ? step : -step);
        runInAction(() => { state.desiredWall = w; });
        player.seekTo(w);
    } else if (e.key === " ") {
        e.preventDefault();
        player.togglePlay();
    }
}

function main(): void {
    configureMobxNextFrameScheduler();
    preact.render(<App />, document.getElementById("app")!);
    window.addEventListener("popstate", () => { if (state.view === "browse") { const d = getUrlDay(); if (d) void selectPeriod(periodStartFromKey(d), false).then(() => applyUrlZoom()); } });
    window.addEventListener("keydown", onKeyDown);
    if (state.ip.trim() && state.password.trim()) void connect();
}
if (!isNode()) main();
