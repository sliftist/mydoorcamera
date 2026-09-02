// Facade for the modular player. The implementation lives under ./player/:
//   gopSource (downloader) · frameStream (streaming VideoFrame decode) · prebuffer (bytes
//   prefetch) · liveDecode (live-path GOP→bitmaps) · renderer (2D draw) ·
//   DayPlayer (review clock/scheduler) · LivePlayer (live).
// Kept here so existing imports (`./videoHelpers`) keep resolving.

export { DayPlayer } from "./player/DayPlayer";
export { LivePlayer } from "./player/LivePlayer";
export { Renderer } from "./player/renderer";
export { isGopDecoded } from "./player/frameStream";
export type { PlayStatus, GapMode } from "./player/types";
