// Rolling measureBlock profile, modeled on querysub's src/diagnostics/watchdog.ts.
// measureBlock wrapping already exists throughout (observer renders, socket-function RPC)
// but only records while a startMeasure() profile is open — so keep one open at all times
// and log its tables every 2 minutes. `logAll(depth?)` in the console dumps everything now.

import { logMeasureTable, startMeasure } from "socket-function/src/profiling/measure";
import { isNode } from "socket-function/src/misc";

const LOG_INTERVAL_MS = 2 * 60 * 1000;

let minTimeToLog = 250;
export function watchdogSetMinTimeToLog(_minTimeToLog: number) {
    minTimeToLog = _minTimeToLog;
}

let measureObj = startMeasure();
function logProfileMeasuresTimingsNow() {
    let profile = measureObj.finish();
    measureObj = startMeasure();
    logMeasureTable(profile, {
        name: `watchdog at ${new Date().toLocaleString()}`,
        minTimeToLog,
        thresholdInTable: 0,
    });
    logMeasureTable(profile, {
        name: `watchdog at ${new Date().toLocaleString()}`,
        mergeDepth: 1,
        minTimeToLog,
    });
}
(globalThis as any).logProfileMeasuresNow = logProfileMeasuresTimingsNow;

export function logAll(depth = 2) {
    let profile = measureObj.finish();
    measureObj = startMeasure();
    logMeasureTable(profile, {
        name: `all logs at ${new Date().toLocaleString()}`,
        mergeDepth: depth,
        minTimeToLog: 0,
        maxTableEntries: 10000000,
        thresholdInTable: 0,
    });
}
(globalThis as any).logAll = logAll;

if (!isNode()) setInterval(logProfileMeasuresTimingsNow, LOG_INTERVAL_MS);
