// Central observable store for the browser app. All UI reads from here; the
// controller modules (session / navigation / trackbar) mutate it inside actions.

import { observable } from "mobx";
import { DayCoverage, Stats, LevelInfo } from "./api";
import { PlayStatus } from "./videoHelpers";

export const lsGet = (k: string): string => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
export const lsSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export const state = observable({
    view: "connect" as "connect" | "browse",
    ip: lsGet("mdc_ip"),
    password: lsGet("mdc_pw"),
    error: "",
    showCertLink: false,
    connecting: false,
    availableDays: [] as string[],   // "YYYY/MM/DD"
    day: "",                         // selected "YYYY/MM/DD"
    coverage: null as DayCoverage | null,
    calMonth: "",                    // "YYYY-MM" shown in the calendar
    playWall: 0,                     // actual playhead (wall-clock ms)
    desiredWall: 0,                  // where the user asked to play
    hoverWall: null as number | null,
    stats: null as Stats | null,
    online: true,
    playStatus: "paused" as PlayStatus,
    live: false,
    playbackRate: 1,
    bufferSec: 0,
    speed: 1,
    level: 0,                        // thinning level being viewed (0 = full res)
    levels: [] as LevelInfo[],       // discovery info for the levels panel
    loadedBytes: 0,                  // total bytes received from the server this session
    loadRateBps: 0,                  // avg inbound bytes/sec over the last 60s
    viewStart: 0,                    // trackbar zoom window (ms); 0 => full day
    viewEnd: 0,
}, undefined, { deep: false });
