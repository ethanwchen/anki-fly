// Shared constants/helpers (the worker entry must export only the handler).
export class HttpError extends Error {
  constructor(public status: number, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

export const SPECIES = ["wild", "white", "ebony", "yellow", "female"] as const;
export const MOODS = [
  "study", "pressAgain", "pressHard", "pressGood", "pressEasy", "celebrate", "dance",
  "zoomies", "crashout", "sulk", "sleepDesk", "still", "idle", "offline",
] as const;
export const COSTUMES = [
  "none", "sunglasses", "monocle", "tophat", "catears", "bunnyears", "partyhat", "crown", "wizard",
  "santa", "pirate", "halo", "devil", "viking", "chef", "graduate", "headphones", "bow", "flowers",
  "cowboy", "beret", "alien", "scarf", "propeller", "pumpkin", "witch", "ghost", "antlers", "elf",
  "stethoscope", "scrubcap", "headmirror", "goggles", "nursecap", "mask", "headset", "dictionary",
  "snowman", "leprechaun", "hearts", "birthday",
] as const;
export const HIDE_FIELDS = ["level", "weekly", "days", "team", "online"] as const;
export const MAX_TEAM = 6;

export const PRESENCE_TTL_S = 120;
export const RATE_LIMIT_PER_MIN = 60;
export const MAX_FRIENDS = 50;
export const MAX_NAME = 24;

export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) {
    // Compare something of equal length anyway so the work done does not depend on the secret.
    crypto.subtle.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.subtle.timingSafeEqual(ab, bb);
}

export function isoWeekKey(unixS: number): string {
  const d = new Date(unixS * 1000);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7; // Mon=1 .. Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // move to the Thursday of this ISO week
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function cleanName(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, "name must be a string");
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "").trim();
  if (s.length > MAX_NAME) throw new HttpError(400, `name must be at most ${MAX_NAME} characters`);
  return s === "" ? undefined : s;
}
