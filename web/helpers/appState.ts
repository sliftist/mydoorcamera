// Central observable store for the browser app. All UI reads from here; the
// controller modules (session / navigation / trackbar) mutate it inside actions.

import { observable } from "mobx";
import { DayCoverage, Stats, LevelInfo } from "./api";
import { PlayStatus } from "./videoHelpers";
import { IndexGop } from "./indexBuffer";

export const lsGet = (k: string): string => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
export const lsSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export const state = observable({
    view: "connect" as "connect" | "browse",
    ip: lsGet("mdc_ip"),
    password: lsGet("mdc_pw"),
    error: "",
    showCertLink: false,
    connecting: false,
    availableDays: [] as string[],   // L0 day folders: "YYYY/MM/DD"
    day: "",                         // selected period key: "YYYY/MM/DD" (L0), "YYYY/MM" (L1), "YYYY" (L2+)
    coverage: null as DayCoverage | null,  // coverage over the period (dayStartMs/dayEndMs = period bounds)
    index: null as IndexGop[] | null,      // per-GOP index for the period (raw download, parsed)
    bufferedRanges: [] as { start: number; end: number }[], // what's actually loaded into the player (wall-clock)
    pickerAnchorMs: 0,               // timestamp the date picker is centered on
    playWall: 0,                     // actual playhead (wall-clock ms)
    desiredWall: 0,                  // where the user asked to play
    hoverWall: null as number | null,
    stats: null as Stats | null,
    online: true,
    playStatus: "paused" as PlayStatus,
    seeking: false,                  // chasing a seek target whose frame isn't shown yet
    live: false,
    playbackRate: 1,
    bufferSec: 0,
    speed: 1,
    level: 0,                        // thinning level being viewed (0 = full res)
    levels: [] as LevelInfo[],       // discovery info for the levels panel
    loadedBytes: 0,                  // total bytes received from the server this session
    loadedGops: 0,                   // GOPs fetched/streamed this session
    loadRateBps: 0,                  // avg inbound bytes/sec over the last 60s
    viewStart: 0,                    // trackbar zoom window (ms); 0 => full day
    viewEnd: 0,
    // Activity sampled at the current view window's resolution (re-fetched on
    // zoom) so zooming in reveals per-GOP detail instead of period-wide buckets.
    viewActivity: null as { fromMs: number; toMs: number; activity: number[] } | null,
    activityExp: 0.4,                // gamma for the activity chart (<1 emphasizes small activity); restored from ?ac
}, undefined, { deep: false });
