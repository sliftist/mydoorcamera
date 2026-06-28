// Facade for the modular player. The implementation lives under ./player/:
//   gopSource (downloader) · frameCache (decoded cache) · gopDecoder (decode) ·
//   prebuffer (pre-render) · renderer (render) · DayPlayer (clock/scheduler).
// Kept here so existing imports (`./videoHelpers`) in session.ts / format.ts still resolve.

export { DayPlayer } from "./player/DayPlayer";
export type { PlayStatus, GapMode } from "./player/types";
