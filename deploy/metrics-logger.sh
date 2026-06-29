#!/bin/bash
# Permanent metrics logger: appends a line every few seconds so a crash always leaves a trail of
# what led up to it (the device has hard-hung with no kernel log). Also a last-resort memory guard:
# if MemAvailable goes critically low, force a reboot — the hardware watchdog does NOT catch an
# OOM-thrash (systemd keeps petting it while the box dies), and we don't want to need a power-cycle.
LOG=/var/lib/mydoorcamera/metrics.log
MAXLINES=20000
REBOOT_KB=120000   # ~120 MB available -> last resort

while true; do
  ts=$(date '+%F %T')
  avail=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
  memused=$(free -m | awk 'NR==2{print $3"/"$2}')
  load=$(awk '{print $1}' /proc/loadavg)
  up=$(cut -d. -f1 /proc/uptime)
  ff=$(pgrep -c ffmpeg)
  recpid=$(pgrep -x recorder)
  recrss=0; [ -n "$recpid" ] && recrss=$(awk '/VmRSS/{print int($2/1024)}' /proc/$recpid/status 2>/dev/null)
  stats=$(cat /var/lib/mydoorcamera/encoder-stats.json 2>/dev/null)
  echo "$ts up=${up}s memAvail=$((avail/1024))MB mem=${memused}MB load=$load ffmpeg=$ff recRSS=${recrss}MB $stats" >> "$LOG"

  lines=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  if [ "${lines:-0}" -gt "$MAXLINES" ]; then tail -n $((MAXLINES/2)) "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi

  if [ "${avail:-999999}" -lt "$REBOOT_KB" ]; then
    echo "$ts CRITICAL low memory ${avail}kB -> forcing reboot" >> "$LOG"
    sync
    reboot -f
  fi
  sleep 3
done
