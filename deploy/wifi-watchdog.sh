#!/bin/bash
# Watches the kernel log for a brcmfmac SDIO error storm and resets the Wi-Fi stack BEFORE it
# cascades into a full system freeze (as happened 2026-07-05: 1368 "failed backplane access over
# SDIO, halting operation" in 18s, then dead). Recording writes to the local SD card and does NOT
# need Wi-Fi, so resetting it is safe.
PATTERN='failed backplane access over SDIO|brcmf_sdio_txfail|brcmf_sdio_bus_sleep: error'
THRESHOLD=8            # matching kernel lines within the window that trigger a reset
LOG=/var/log/wifi-watchdog.log
log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }
log "wifi-watchdog started"
while true; do
  sleep 15
  n=$(journalctl -k --since "30 seconds ago" --no-pager 2>/dev/null | grep -acE "$PATTERN")
  if [ "${n:-0}" -ge "$THRESHOLD" ]; then
    log "SDIO error storm ($n in 30s) -> resetting Wi-Fi"
    modprobe -r brcmfmac 2>>"$LOG"; sleep 2; modprobe brcmfmac 2>>"$LOG"; sleep 8
    iw dev wlan0 set power_save off 2>/dev/null
    systemctl restart NetworkManager 2>>"$LOG" || true
    log "Wi-Fi reset complete"
    sleep 45           # cooldown so post-reset settling messages don't retrigger
  fi
done
