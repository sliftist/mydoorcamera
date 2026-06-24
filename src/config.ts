// Central configuration — the single source of truth for the camera app.
// Storage currently lives on the SD card; switch DATA_DIR to the new
// high-endurance card / SSD when it arrives (one line, nothing else changes).

import * as os from "os";

export const DATA_DIR = process.env.MYDOORCAMERA_DATA || "/var/lib/mydoorcamera/data";

// Capture — the FPS-tuned 1080p30 hardware-encode pipeline (see capture.ts).
export const VIDEO_DEVICE = process.env.MYDOORCAMERA_VIDEO || "/dev/video0";
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const FPS = 30;
export const BITRATE = 5_000_000;     // 5 Mbps H.264
export const GOP = 30;                // keyframe every 30 frames (~1s)

// Rolling retention: keep at most this many bytes of video, deleting oldest.
// Start at 16 GB (SD card has ~21 GB free); raise once on a bigger drive.
export const RETENTION_BYTES = Number(process.env.MYDOORCAMERA_RETENTION_BYTES) || 16 * 1024 * 1024 * 1024;

// HTTPS / WSS server.
export const SERVER_PORT = Number(process.env.MYDOORCAMERA_PORT) || 8443;
export const CERT_DIR = process.env.MYDOORCAMERA_CERT_DIR || "/var/lib/mydoorcamera/cert";

// Auth: password is N words from the first 1024 of the letterfast word list.
export const PASSWORD_WORD_COUNT = 4;
export const WORDLIST_SIZE = 1024;
export const MAX_PASSWORD_ATTEMPTS_PER_DAY = 1000; // then permanent IP blacklist

export function firstLanIp(): string {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const i of ifaces[name] || []) {
            if (i.family === "IPv4" && !i.internal) return i.address;
        }
    }
    return "127.0.0.1";
}
