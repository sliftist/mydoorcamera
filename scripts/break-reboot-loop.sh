#!/usr/bin/env bash
# The pi is stuck rebooting itself ~1s into every boot (stale-clock 04:00 timer -> daily-reboot.sh
# -> sysrq reboot). daily-reboot.sh does `sync; sync; sleep 1` before the reboot, so SSH answers
# for a ~2s window each cycle. Hammer SSH overlapping and, the instant we get in, kill the pending
# reboot and mask the timer+service so the loop can't re-arm. Runs until masking sticks; verify
# with the poller (uptime should start climbing past 0).

set -uo pipefail

HOST="10.0.0.189"
INTERVAL_SEC=0.7      # hammer faster than the poller to improve odds of hitting the ~2s window
TIMEOUT_SEC=4

SSH_OPTS=(
    -o BatchMode=yes
    -o StrictHostKeyChecking=no
    -o ConnectTimeout=3
    -o ServerAliveInterval=1
    -o ServerAliveCountMax=2
)

# Kill this cycle's reboot FIRST (before its sleep elapses), then mask so future boots can't fire
# it. Try sudo -n, fall back to plain in case we're already root — either way report who we are and
# the resulting state so we can see whether privilege was the blocker.
BREAK_CMD='
( sudo -n pkill -9 -f daily-reboot.sh 2>&1 || pkill -9 -f daily-reboot.sh 2>&1 );
( sudo -n systemctl mask --now daily-reboot.timer daily-reboot.service 2>&1 || systemctl mask --now daily-reboot.timer daily-reboot.service 2>&1 );
echo "WHOAMI=$(id -un) UPTIME=$(cut -d. -f1 /proc/uptime) SYNCED=$(timedatectl show -p NTPSynchronized --value 2>/dev/null)";
echo "TIMER_STATE=$(systemctl is-enabled daily-reboot.timer 2>&1) SERVICE_STATE=$(systemctl is-enabled daily-reboot.service 2>&1)";
'

echo "Hammering ${HOST} to break the reboot loop (Ctrl-C to stop)." >&2

attempt() {
    local ts out rc
    ts=$(date +%H:%M:%S)
    out=$(timeout --kill-after=1 "${TIMEOUT_SEC}" ssh -T "${SSH_OPTS[@]}" "${HOST}" "${BREAK_CMD}" 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
        echo "==== [${ts}] GOT IN ===="  >&2
        printf '%s\n' "$out" >&2
    else
        echo "[${ts}] miss (rc=${rc})" >&2
    fi
}

trap 'echo; echo "Stopped." >&2; exit 0' INT TERM

while true; do
    attempt &
    sleep "${INTERVAL_SEC}"
done
