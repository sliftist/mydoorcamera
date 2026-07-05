// Activity-region thumbnails. These are now PRE-RENDERED by the recorder in-pipeline (the raw
// camera JPEG of each activity section's peak-activity frame, written straight to disk) — so the
// client just fetches the JPEG bytes. No fetching an encoded GOP, no WebCodecs decode, no
// re-encode. Both readers are reactive (asyncCache): read them inside an @observer render().

import { asyncCache } from "sliftutils/render-utils/asyncObservable";
import { api } from "./session";

// Cached list of pre-rendered thumbnails ({ t, a }) for a period. Match regions to these by time.
export const getThumbList = asyncCache(async ({ fromMs, toMs }: { fromMs: number; toMs: number }): Promise<{ t: number; a: number }[]> => {
    if (!api) return [];
    try { return await api.listThumbs(fromMs, toMs); } catch { return []; }
});

// Blob URL for one pre-rendered thumbnail (undefined while loading, "" on failure).
export const getThumbUrl = asyncCache(async ({ t, a }: { t: number; a: number }): Promise<string> => {
    if (!api) return "";
    try {
        const bytes = await api.getThumb(t, a);
        if (!bytes || !bytes.length) return "";
        return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    } catch { return ""; }
});
