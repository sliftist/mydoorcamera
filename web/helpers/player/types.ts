// Shared types for the modular player (web/helpers/player/*).

import { GopEntry } from "../api";
export type { GopEntry };

export type PlayStatus = "playing" | "paused" | "waiting" | "unavailable";
export type GapMode = "blank" | "skip";

// A decoded frame tagged with its footage wall-clock time (ms). `frame` is a
// WebCodecs VideoFrame (typed `any` — WebCodecs lib types aren't in our tsconfig).
export type Decoded = { wall: number; frame: any };

export type RenderResult = "hit" | "miss";

// Window/global handle (WebCodecs lives on window; absent under Node typecheck).
export const W: any = typeof window !== "undefined" ? window : {};
