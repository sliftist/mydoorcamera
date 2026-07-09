#!/bin/bash
# Proactive daily reboot: keeps the Pi in a known-good state by clearing any accumulated
# driver/memory/handle state before it can degrade. Uses the lowest-level reboot that userspace
# can issue, so no hung service can block it (only a total kernel freeze could — the hardware
# watchdog / panic-on-hang settings cover that).

# The Pi has no RTC, so at boot the clock is restored to the last saved (~04:00) time. Without
# these guards the 04:00 timer fires ~1s into every boot, hard-reboots, and the box never gets
# past ~04:00 again — an unbreakable reboot loop. Refuse to reboot unless the clock is real
# (NTP-synced) AND we're well past boot, so a stale-clock trigger can never reboot the box.
MIN_UPTIME_SECONDS=600

uptime_seconds=$(cut -d. -f1 /proc/uptime)
clock_synced=$(timedatectl show -p NTPSynchronized --value 2>/dev/null)

if [ "${clock_synced}" != "yes" ]; then
    logger -t daily-reboot "skipping reboot: clock not NTP-synced (NTPSynchronized=${clock_synced:-unknown})"
    exit 0
fi
if [ "${uptime_seconds}" -lt "${MIN_UPTIME_SECONDS}" ]; then
    logger -t daily-reboot "skipping reboot: only up ${uptime_seconds}s (< ${MIN_UPTIME_SECONDS}s) — likely a stale-clock boot trigger"
    exit 0
fi

logger -t daily-reboot "scheduled 04:00 reboot"
sync; sync; sleep 1
echo 1 > /proc/sys/kernel/sysrq 2>/dev/null
echo b > /proc/sysrq-trigger 2>/dev/null   # immediate reboot, unblockable
reboot -f                                   # fallback if sysrq is unavailable
