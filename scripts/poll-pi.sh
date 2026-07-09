#!/usr/bin/env bash
# Poll the pi over SSH once per second with overlapping, self-killing attempts,
# grabbing a resource + process snapshot each time it answers. The point is to
# catch the brief window right after boot where something wedges/reboots the
# box: each success is stamped with when the probe started and finished.
#
# Output (base name from $1, default pi-poll-<timestamp>):
#   <base>.summary   one line per successful probe — the at-a-glance view.
#                    `up=` is uptime in SECONDS: if it keeps resetting to a
#                    small number, the box is reboot-cycling.
#   <base>.d/*.txt   full per-probe detail (one file per snapshot, so
#                    overlapping probes never interleave into each other).

set -uo pipefail

HOST="10.0.0.189"
INTERVAL_SEC=1        # launch a fresh attempt this often
TIMEOUT_SEC=5         # kill an attempt that hasn't finished by now

BASE="${1:-pi-poll-$(date +%Y%m%d-%H%M%S)}"
BASE="${BASE%.log}"   # tolerate being handed a .log name
SUMMARY="${BASE}.summary"
DETAIL_DIR="${BASE}.d"
mkdir -p "${DETAIL_DIR}"

# Fail fast on the connect so a wedged box doesn't hold the socket for the full
# TCP timeout; BatchMode keeps any prompt from hanging a probe.
SSH_OPTS=(
    -o BatchMode=yes
    -o StrictHostKeyChecking=no
    -o ConnectTimeout=3
    -o ServerAliveInterval=1
    -o ServerAliveCountMax=2
)

# Raw data only — no remote quoting games. All summarizing is done locally so
# this string stays single-quote-clean. /proc/uptime first field is the cycling
# tell; free/df give mem+disk; top/ps give the CPU hogs if there are any.
REMOTE_CMD='
echo "=== proc_uptime ==="; cat /proc/uptime;
echo "=== loadavg ==="; cat /proc/loadavg;
echo "=== free ==="; free -m;
echo "=== df ==="; df -h;
echo "=== top ==="; top -b -n1 -w 512 | head -n 30;
echo "=== ps (by cpu) ==="; ps -eo pid,ppid,stat,etimes,pcpu,pmem,comm,args --sort=-pcpu | head -n 40;
echo "=== ps (by mem) ==="; ps -eo pid,ppid,stat,etimes,pcpu,pmem,comm,args --sort=-pmem | head -n 20;
echo "=== recently started (youngest first) ==="; ps -eo etimes,pid,comm,args --sort=etimes | head -n 40;
echo "=== systemd running/activating ==="; systemctl list-units --type=service --state=running,activating --no-pager --no-legend 2>/dev/null;
echo "=== systemd jobs in flight ==="; systemctl list-jobs --no-pager --no-legend 2>/dev/null;
echo "=== last dmesg ==="; dmesg 2>/dev/null | tail -n 30;
'

echo "Polling ${HOST} every ${INTERVAL_SEC}s (kill after ${TIMEOUT_SEC}s)." >&2
echo "Summary -> ${SUMMARY}   detail -> ${DETAIL_DIR}/" >&2
echo "Ctrl-C to stop." >&2

# Pull the summary fields out of one probe's captured text. Kept local so the
# remote command needs no awk/quoting.
summarize() {
    printf '%s\n' "$1" | awk '
        /=== proc_uptime ===/ { getline; up = int($1); next }
        /=== loadavg ===/     { getline; load = $1; next }
        /^%Cpu/ {
            n = split($0, a, ",");
            for (i = 1; i <= n; i++) if (a[i] ~ /id/) { gsub(/[^0-9.]/, "", a[i]); idle = a[i] }
            next
        }
        /^Mem:/  { memtot = $2; memused = $3; next }
        $NF == "/" && $(NF-1) ~ /%$/ { disk = $(NF-1); next }
        END {
            printf "up=%ss load=%s cpu_idle=%s%% mem=%s/%sMB disk=%s",
                   (up==""?"?":up), (load==""?"?":load), (idle==""?"?":idle),
                   (memused==""?"?":memused), (memtot==""?"?":memtot), (disk==""?"?":disk)
        }'
}

attempt() {
    local start_epoch start_iso end_epoch end_iso out rc elapsed reboot summary detail
    start_epoch=$(date +%s.%N)
    start_iso=$(date +%H:%M:%S)

    # timeout --kill-after guarantees a hung ssh is SIGKILLed even if it ignores
    # TERM. -T: no pty, we only want the batch output.
    out=$(timeout --kill-after=1 "${TIMEOUT_SEC}" ssh -T "${SSH_OPTS[@]}" "${HOST}" "${REMOTE_CMD}" 2>&1)
    rc=$?

    end_epoch=$(date +%s.%N)
    end_iso=$(date +%H:%M:%S)
    elapsed=$(awk "BEGIN{printf \"%.2f\", ${end_epoch}-${start_epoch}}")

    if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
        # daily-reboot showing up in the in-flight jobs is the thing we're hunting.
        if printf '%s\n' "$out" | grep -qi 'daily-reboot'; then
            reboot="REBOOT-PENDING"
        else
            reboot="-"
        fi
        summary="[${start_iso}->${end_iso} ${elapsed}s] $(summarize "$out") reboot=${reboot}"

        # One file per snapshot -> overlapping probes can't garble each other.
        detail="${DETAIL_DIR}/snap-${start_epoch}.txt"
        {
            echo "# STARTED : ${start_iso} (${start_epoch})"
            echo "# FINISHED: ${end_iso} (${end_epoch})  ELAPSED ${elapsed}s"
            echo "# ${summary}"
            echo
            echo "${out}"
        } >"${detail}"

        # Summary line is short (< PIPE_BUF) so concurrent O_APPEND stays intact.
        echo "${summary}" >>"${SUMMARY}"
        echo "${summary}" >&2
    else
        echo "[${start_iso}] MISS (rc=${rc})" >&2
    fi
}

trap 'echo; echo "Stopped. Summary: ${SUMMARY}  Detail: ${DETAIL_DIR}/" >&2; exit 0' INT TERM

while true; do
    attempt &          # overlapping: don't wait for the previous probe
    sleep "${INTERVAL_SEC}"
done
