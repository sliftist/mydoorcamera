// Auth for the server (Node-only). Password = N words from the first 1024
// frequency-ordered letterfast words, generated once and persisted. An IP that
// makes more than MAX_PASSWORD_ATTEMPTS_PER_DAY failed attempts in a calendar
// day is permanently blacklisted (no rate-limiting before that — try freely
// until you hit the cap, then you're out forever).

import { promises as fsp } from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { PASSWORD_WORD_COUNT, WORDLIST_SIZE, MAX_PASSWORD_ATTEMPTS_PER_DAY } from "./config";

const SECRET_DIR = "/var/lib/mydoorcamera";
const PASSWORD_FILE = path.join(SECRET_DIR, "password.txt");
const BLACKLIST_FILE = path.join(SECRET_DIR, "blacklist.json");

const WORDS: string[] = (require("./words1024.json") as string[]).slice(0, WORDLIST_SIZE);

function normalize(s: string): string {
    // The password is just a sequence of words, so keep only alphabet letters
    // (lowercased) and drop spaces/punctuation/casing. Makes it forgiving of
    // voice typing, which sprinkles in commas, periods and stray capitalization.
    return s.toLowerCase().replace(/[^a-z]/g, "");
}

let cachedPassword = "";
export async function getPassword(): Promise<string> {
    if (cachedPassword) return cachedPassword;
    try {
        const fromDisk = (await fsp.readFile(PASSWORD_FILE, "utf8")).trim();
        if (fromDisk) { cachedPassword = fromDisk; return cachedPassword; } // keep display form (with spaces)
    } catch { /* not generated yet */ }
    const picked = Array.from({ length: PASSWORD_WORD_COUNT }, () => WORDS[crypto.randomInt(WORDS.length)]);
    cachedPassword = picked.join(" ");
    await fsp.mkdir(SECRET_DIR, { recursive: true });
    await fsp.writeFile(PASSWORD_FILE, cachedPassword + "\n", { mode: 0o600 });
    return cachedPassword;
}

export async function checkPassword(input: string): Promise<boolean> {
    // Compare on the alpha-only normalized form of both sides.
    const a = Buffer.from(normalize(input));
    const b = Buffer.from(normalize(await getPassword()));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- blacklist / attempt tracking ----
let blacklist: Set<string> | undefined;
async function ensureBlacklist(): Promise<Set<string>> {
    if (blacklist) return blacklist;
    try { blacklist = new Set<string>(JSON.parse(await fsp.readFile(BLACKLIST_FILE, "utf8"))); }
    catch { blacklist = new Set<string>(); }
    return blacklist;
}

const attempts = new Map<string, { day: string; count: number }>();
function today(): string { return new Date().toISOString().slice(0, 10); }

async function saveBlacklist(): Promise<void> {
    try { await fsp.mkdir(SECRET_DIR, { recursive: true }); await fsp.writeFile(BLACKLIST_FILE, JSON.stringify([...(blacklist || [])])); }
    catch { /* ignore */ }
}

export async function isBlacklisted(ip: string): Promise<boolean> {
    return (await ensureBlacklist()).has(ip);
}

// Returns true if this failed attempt pushed the IP over the cap (now blacklisted).
export async function recordFailedAttempt(ip: string): Promise<boolean> {
    const bl = await ensureBlacklist();
    if (bl.has(ip)) return true;
    const d = today();
    let a = attempts.get(ip);
    if (!a || a.day !== d) { a = { day: d, count: 0 }; attempts.set(ip, a); }
    a.count++;
    if (a.count > MAX_PASSWORD_ATTEMPTS_PER_DAY) {
        bl.add(ip);
        await saveBlacklist();
        return true;
    }
    return false;
}
