// Trackbar interaction: drag-to-seek, scroll-wheel zoom, and the zoom window math.

import { runInAction } from "mobx";
import { state } from "./appState";
import { player } from "./session";
import { saveUrlPosition } from "./navigation";
import { bucketActivity } from "./indexBuffer";

let trackEl: HTMLElement | null = null;
let dragging = false;

// Re-sample activity from the in-memory index for the current zoom window — this
// is what reveals per-GOP detail when zooming in. Client-side and fast.
function recomputeViewActivity(): void {
    if (!state.index || !state.coverage) return;
    const from = state.viewStart || state.coverage.dayStartMs;
    const to = state.viewEnd || state.coverage.dayEndMs;
    runInAction(() => { state.viewActivity = { fromMs: from, toMs: to, activity: bucketActivity(state.index!, from, to, 1440) }; });
}

// Persist the zoom window to the URL (debounced; ?z is part of saveUrlPosition's suffix).
let urlTimer: ReturnType<typeof setTimeout> | undefined;
function persistView(): void { if (urlTimer) clearTimeout(urlTimer); urlTimer = setTimeout(() => saveUrlPosition(state.playWall), 350); }

// The visible trackbar window (zoomable). Falls back to the full day.
export function viewBounds(): { vs: number; ve: number } {
    const c = state.coverage!;
    return { vs: state.viewStart || c.dayStartMs, ve: state.viewEnd || c.dayEndMs };
}

export function clientToWall(clientX: number): number | undefined {
    if (!trackEl || !state.coverage) return undefined;
    const r = trackEl.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const { vs, ve } = viewBounds();
    return vs + f * (ve - vs);
}

export function resetZoom(): void {
    if (!state.coverage) return;
    runInAction(() => { state.viewStart = state.coverage!.dayStartMs; state.viewEnd = state.coverage!.dayEndMs; });
    recomputeViewActivity();
    persistView();
}

// Scroll wheel zooms in/out around the cursor, keeping the time under the cursor fixed.
function onTrackWheel(e: WheelEvent): void {
    if (!state.coverage) return;
    e.preventDefault();
    const c = state.coverage;
    const { vs, ve } = viewBounds();
    const span = ve - vs;
    const cursor = clientToWall(e.clientX);
    if (cursor == null) return;
    const daySpan = c.dayEndMs - c.dayStartMs;
    let newSpan = span * (e.deltaY < 0 ? 0.8 : 1.25);     // up = zoom in, down = zoom out
    newSpan = Math.max(2000, Math.min(daySpan, newSpan)); // 2s min, full day max
    const f = (cursor - vs) / span;                       // keep cursor's time under the cursor
    let ns = cursor - f * newSpan;
    let ne = ns + newSpan;
    if (ns < c.dayStartMs) { ns = c.dayStartMs; ne = ns + newSpan; }
    if (ne > c.dayEndMs) { ne = c.dayEndMs; ns = ne - newSpan; }
    runInAction(() => { state.viewStart = Math.max(c.dayStartMs, ns); state.viewEnd = ne; });
    recomputeViewActivity();
    persistView();
}

function seekToWall(wall: number): void {
    runInAction(() => { state.desiredWall = wall; });
    player?.seekTo(wall);
}

export function onTrackDown(e: any): void {
    if (!state.coverage) return;
    if (e.button === 1) { startPan(e); return; }  // middle-button = pan the zoom window
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    const w = clientToWall(e.clientX); if (w != null) { seekToWall(w); saveUrlPosition(w); }
    window.addEventListener("mousemove", onTrackDrag);
    window.addEventListener("mouseup", onTrackUp);
}

// ---- middle-button drag to pan the zoomed view ----
let panning = false, panStartX = 0, panStartVs = 0, panStartVe = 0;
function startPan(e: MouseEvent): void {
    e.preventDefault();
    panning = true;
    panStartX = e.clientX;
    const { vs, ve } = viewBounds();
    panStartVs = vs; panStartVe = ve;
    window.addEventListener("mousemove", onPanDrag);
    window.addEventListener("mouseup", onPanUp);
}
function onPanDrag(e: MouseEvent): void {
    if (!panning || !trackEl || !state.coverage) return;
    const c = state.coverage;
    const span = panStartVe - panStartVs;
    const wallDelta = ((e.clientX - panStartX) / trackEl.getBoundingClientRect().width) * span; // grab-and-drag the content
    let ns = panStartVs - wallDelta, ne = panStartVe - wallDelta;
    if (ns < c.dayStartMs) { ne += c.dayStartMs - ns; ns = c.dayStartMs; }
    if (ne > c.dayEndMs) { ns -= ne - c.dayEndMs; ne = c.dayEndMs; }
    runInAction(() => { state.viewStart = Math.max(c.dayStartMs, ns); state.viewEnd = ne; });
    recomputeViewActivity();
    persistView();
}
function onPanUp(): void {
    panning = false;
    window.removeEventListener("mousemove", onPanDrag);
    window.removeEventListener("mouseup", onPanUp);
}
function onTrackDrag(e: MouseEvent): void {
    if (!dragging) return;
    const w = clientToWall(e.clientX);
    if (w != null) { runInAction(() => { state.hoverWall = w; }); seekToWall(w); }
}
function onTrackUp(): void {
    dragging = false;
    window.removeEventListener("mousemove", onTrackDrag);
    window.removeEventListener("mouseup", onTrackUp);
    saveUrlPosition(state.desiredWall); // drag finished
}

// Attach a NON-passive wheel listener so we can preventDefault the page scroll.
export function setTrackRef(el: HTMLElement | null): void {
    if (trackEl && trackEl !== el) trackEl.removeEventListener("wheel", onTrackWheel as any);
    trackEl = el;
    if (el) el.addEventListener("wheel", onTrackWheel as any, { passive: false });
}

// Current rendered width of the trackbar in px (for deciding GOP-marker visibility).
export function getTrackWidth(): number { return trackEl ? trackEl.getBoundingClientRect().width : 0; }

// Hover handlers used by the Trackbar component.
export function onTrackHover(clientX: number): void { const w = clientToWall(clientX); if (w != null) runInAction(() => { state.hoverWall = w; }); }
export function onTrackLeave(): void { if (!dragging) runInAction(() => { state.hoverWall = null; }); }
