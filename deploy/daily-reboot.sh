#!/bin/bash
# Proactive daily reboot: keeps the Pi in a known-good state by clearing any accumulated
# driver/memory/handle state before it can degrade. Uses the lowest-level reboot that userspace
# can issue, so no hung service can block it (only a total kernel freeze could — the hardware
# watchdog / panic-on-hang settings cover that).
logger -t daily-reboot "scheduled 04:00 reboot"
sync; sync; sleep 1
echo 1 > /proc/sys/kernel/sysrq 2>/dev/null
echo b > /proc/sysrq-trigger 2>/dev/null   # immediate reboot, unblockable
reboot -f                                   # fallback if sysrq is unavailable
