// Central configuration — the single source of truth for the camera app.
// Kept isomorphic (no Node-only imports) so the browser can import constants
// like FPS. Node-only helpers (firstLanIp) live in the server.
// Storage currently lives on the SD card; switch DATA_DIR to the new
// high-endurance card / SSD when it arrives (one line, nothing else changes).

declare const process: any;
const env = (typeof process !== "undefined" && process.env) || {};

// Storage root. Binary-index format lives here (renamed again for a clean start).
export const DATA_DIR = env.MYDOORCAMERA_DATA || "/var/lib/mydoorcamera/video";

// Capture — the FPS-tuned 1080p30 hardware-encode pipeline (see capture.ts).
export const VIDEO_DEVICE = env.MYDOORCAMERA_VIDEO || "/dev/video0";
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const FPS = 30;
export const BITRATE = 5_000_000;     // 5 Mbps H.264
export const GOP = 30;                // keyframe every 30 frames (~1s)

// Rolling retention: keep at most this many bytes of video, deleting oldest.
// Start at 16 GB (SD card has ~21 GB free); raise once on a bigger drive.
export const RETENTION_BYTES = Number(env.MYDOORCAMERA_RETENTION_BYTES) || 16 * 1024 * 1024 * 1024;

// ---- Video thinning (see docs/thinning.md) ----
// Cascading keyframe thinning keeps a sparser copy of old footage instead of
// just deleting it. Level L keeps 1 of every THIN_FACTOR frames of level L-1
// (which lands on keyframes, since GOP == THIN_FACTOR), re-encoded into normal
// 30-frame GOPs. One L-level GOP plays in ~1s and covers 30^L real seconds.
export const THIN_FACTOR = GOP;            // keep 1 of every 30 frames per level (== GOP)
export const THIN_LEVELS = 4;             // generate L1..L4 (L0 is the unthinned root)
export const THIN_GOP_FRAMES = 30;        // frames per re-encoded thinned GOP
// Re-encode thinned GOPs on the GPU (v4l2h264enc), full resolution. Thinned frames
// are sparse — at a high thinning level you may only get a few frames of whatever
// you're looking for — so we encode them near-losslessly: quality over size, since
// the effective frame rate (and thus data volume) is tiny anyway. A low QP floor +
// max bitrate also stops the VBR rate-controller from crushing the cold IDR (the
// first frame of each fresh 30-frame encode), which was the start-of-group blockiness.
export const THIN_BITRATE = 25_000_000;   // 25 Mbps (encoder max) VBR target
export const THIN_MIN_QP = 10;            // low QP floor -> near-lossless sharp frames
export const THIN_MAX_QP = 20;            // cap so the cold IDR can't be crushed
export const LEVEL_COUNT = THIN_LEVELS + 1; // 5 levels total (L0..L4)
// Thinned levels live in their own tree (kept out of DATA_DIR's year scan).
export const THIN_DIR = env.MYDOORCAMERA_THIN || "/var/lib/mydoorcamera/thin";
// Split the whole byte budget evenly across the 5 levels (~3.2 GB each at 16 GB).
export const LEVEL_BUDGET_BYTES = Math.floor(RETENTION_BYTES / LEVEL_COUNT);

// Real seconds one GOP at this level spans (== 30^level). L0 = 1s.
export function levelGopSpanSec(level: number): number { return Math.pow(THIN_FACTOR, level); }
// Real seconds represented by one second of playback at this level (a GOP plays
// in ~1s, so this equals the GOP span): L0=1, L1=30, L2=900, L3=27000, L4=810000.
export function levelTimePerSec(level: number): number { return Math.pow(THIN_FACTOR, level); }

// Navigable period for a level, matching its on-disk folder span (see storage
// bucketOf): L0 = a day, L1 = a month, L2+ = a year. The date picker and trackbar
// span this period.
export function levelPeriod(level: number): "day" | "month" | "year" {
    return level === 0 ? "day" : level === 1 ? "month" : "year";
}

// HTTPS / WSS server.
export const SERVER_PORT = Number(env.MYDOORCAMERA_PORT) || 8443;
export const CERT_DIR = env.MYDOORCAMERA_CERT_DIR || "/var/lib/mydoorcamera/cert";

// Auth: password is N words from the first 1024 of the letterfast word list.
export const PASSWORD_WORD_COUNT = 4;
export const WORDLIST_SIZE = 1024;
export const MAX_PASSWORD_ATTEMPTS_PER_DAY = 1000; // then permanent IP blacklist
