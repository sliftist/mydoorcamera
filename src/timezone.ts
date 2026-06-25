// Resolves the timezone used for the burned-in video timestamp and the on-disk
// date folders. Persists a best-effort IP-geolocation result; until then (and if
// geolocation fails) it falls back to US Eastern, which handles EST/EDT for us.
//
// Setting process.env.TZ to the result makes both Node's Date and gstreamer's
// clockoverlay (which inherits the env) render local time in that zone.

import * as fs from "fs";
import * as https from "https";

const TZ_FILE = "/var/lib/mydoorcamera/timezone.txt";
const FALLBACK = "America/New_York"; // Eastern; auto-handles daylight saving

export function getTimezone(): string {
    let tz = "";
    try { tz = fs.readFileSync(TZ_FILE, "utf8").trim(); } catch { /* not detected yet */ }
    if (!tz) {
        detectAndPersist(); // best-effort; takes effect on the next restart
        return FALLBACK;
    }
    return tz;
}

function detectAndPersist(): void {
    const req = https.get("https://ipapi.co/timezone/", res => {
        let data = "";
        res.on("data", d => (data += d));
        res.on("end", () => {
            const tz = data.trim();
            if (tz.length > 0 && tz.length < 64 && /^[A-Za-z_+\-]+\/[A-Za-z_+\-/]+$/.test(tz)) {
                try {
                    fs.mkdirSync("/var/lib/mydoorcamera", { recursive: true });
                    fs.writeFileSync(TZ_FILE, tz + "\n");
                    console.log(`[tz] detected timezone ${tz} (active after next restart)`);
                } catch { /* ignore */ }
            }
        });
    });
    req.on("error", () => { /* keep fallback */ });
    req.setTimeout(5000, () => req.destroy());
}
