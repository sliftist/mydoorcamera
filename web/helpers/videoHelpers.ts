// Facade for the modular player. The implementation lives under ./player/:
//   gopSource (downloader) · frameCache (generative decode cache) · prebuffer (pre-render) ·
//   renderer (WebGPU/2D draw) · DayPlayer (review clock/scheduler) · LivePlayer (live).
// Kept here so existing imports (`./videoHelpers`) keep resolving.

export { DayPlayer } from "./player/DayPlayer";
export { LivePlayer } from "./player/LivePlayer";
export { Renderer } from "./player/renderer";
export { isGopDecoded } from "./player/frameCache";
export type { PlayStatus, GapMode } from "./player/types";
