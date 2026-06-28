// Shared types for the modular player (web/helpers/player/*).

import { GopEntry } from "../api";
export type { GopEntry };

export type PlayStatus = "playing" | "paused" | "waiting" | "unavailable";
export type GapMode = "blank" | "skip";
