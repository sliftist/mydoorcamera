// Module-level ring buffer of playback state-machine transitions. Lives at module
// scope (NOT on the DayPlayer instance) so the log survives player reconstruction
// across day/level changes — a playback bug spanning a level switch is still captured.
//
// Entries hold only scalars / short summaries; the (large) GOP index is never stored.
// The "⤓ debug" button serializes this to a JSON file the user can hand back for
// post-mortem of exactly what the state machine did.

export type FsmLogEntry = {
    ts: number;                          // Date.now()
    seq: number;                         // monotonic sequence
    ev: string;                          // event type
    arg?: string | number;              // short scalar arg (wall ms, speed, mode) — never an object
    from: string;                        // state before
    to: string;                          // state after
    ctx: Record<string, unknown>;       // simplified scalar snapshot
    actions?: string[];                 // idempotent side-effects taken this dispatch
};

const LOG: FsmLogEntry[] = [];
const LOG_MAX = 3000;
let seq = 0;

export function pushFsmEntry(e: Omit<FsmLogEntry, "seq">): void {
    const entry: FsmLogEntry = { ...e, seq: seq++ };
    LOG.push(entry);
    if (LOG.length > LOG_MAX) LOG.shift();
    try {
        const a = entry.actions && entry.actions.length ? ` {${entry.actions.join(",")}}` : "";
        const arg = entry.arg !== undefined ? `(${entry.arg})` : "";
        // eslint-disable-next-line no-console
        console.debug(`[fsm] ${entry.from}->${entry.to} ${entry.ev}${arg}${a}`, entry.ctx);
    } catch { /* */ }
}

export function getFsmLog(): FsmLogEntry[] { return LOG; }

function fmtLine(e: FsmLogEntry): string {
    const arg = e.arg !== undefined ? `(${e.arg})` : "";
    const a = e.actions && e.actions.length ? ` {${e.actions.join(",")}}` : "";
    return `${new Date(e.ts).toISOString()} #${e.seq} ${e.from}->${e.to} ${e.ev}${arg}${a} ${JSON.stringify(e.ctx)}`;
}
export function fsmLogText(): string { return LOG.map(fmtLine).join("\n"); }

// Serialize the log (+ a little environment) to a JSON file and trigger a download.
export function downloadDebugInfo(): void {
    const payload = {
        generatedAt: new Date().toISOString(),
        url: typeof location !== "undefined" ? location.href : "",
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        count: LOG.length,
        log: LOG,
    };
    try {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `mdc-debug-${seq}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { console.error("[fsm] debug download failed", e); }
}
