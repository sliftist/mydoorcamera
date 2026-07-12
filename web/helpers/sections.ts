// Activity sections for the activity list. These are RECORDED by the recorder in-pipeline (one
// record per section: start, end, peak-frame time, peak activity) and fetched as a tiny list.
// The activity UI uses ONLY this — it must NEVER load the per-frame/per-GOP index to rebuild
// sections (that granular data is large and exists only for the trackbar). Threshold just filters
// this list by peak activity; it never re-segments anything.

import { asyncCache } from "sliftutils/render-utils/asyncObservable";
import { api } from "./session";

export type Section = { s: number; e: number; t: number; a: number }; // startMs, endMs, peakMs, peak 0..1

// Reactive list of activity sections for a period (read inside an @observer render()). Pass the
// current state.sectionsVersion so bumping it (when the day watch reports new activity) refetches.
export const getSectionList = asyncCache(async ({ fromMs, toMs }: { fromMs: number; toMs: number; version?: number }): Promise<Section[]> => {
    if (!api) return [];
    try { return await api.getActivitySections(fromMs, toMs); } catch { return []; }
});
