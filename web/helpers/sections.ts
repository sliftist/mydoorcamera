// Activity sections for the activity list. These are RECORDED by the recorder in-pipeline (one
// record per section: start, end, peak-frame time, peak activity) and fetched as a tiny list.
// The activity UI uses ONLY this — it must NEVER load the per-frame/per-GOP index to rebuild
// sections (that granular data is large and exists only for the trackbar). Threshold just filters
// this list by peak activity; it never re-segments anything.
//
// We keep the list in an observable (state.sections) and refresh it imperatively — on day change
// and when the day watch reports new activity. The list is ONLY replaced on a successful fetch, so
// the activity cards never flash empty while a refresh is in flight.

import { runInAction } from "mobx";
import { state } from "./appState";
import { api } from "./session";

export type Section = { s: number; e: number; t: number; a: number }; // startMs, endMs, peakMs, peak 0..1

let inflight = false;
export async function refreshSections(): Promise<void> {
    if (!api || !state.coverage || inflight) return;
    inflight = true;
    const from = state.coverage.dayStartMs, to = state.coverage.dayEndMs, day = state.day;
    try {
        const secs = await api.getActivitySections(from, to);
        // Only apply if we're still on the same day (a late response mustn't clobber a newer day).
        if (state.day === day) runInAction(() => { state.sections = secs; state.sectionsDay = day; });
    } catch { /* keep the previous list rather than blanking it */ }
    finally { inflight = false; }
}
