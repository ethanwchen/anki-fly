/**
 * Drosophil-Anki friends backend: a Cloudflare Worker backed by one KV namespace (`FLY`).
 *
 * KV layout
 *   tok:<sha256(token)>      -> code                       (token index; the real token lives in the user row)
 *   user:<code>              -> User
 *   pres:<code>              -> Presence
 *   friends:<code>           -> string[] of codes          (kept symmetric)
 *   race:<code>:<weekKey>    -> RaceRow
 *   rl:<id>:<minute>         -> request count              (rate limiting, expires on its own)
 *
 * Nothing about cards, decks or notes is ever accepted or stored; bodies with unknown fields are rejected.
 */

export interface Env {
  FLY: KVNamespace;
}

// ---------- constants / allowlists ----------

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
const MAX_BODY_BYTES = 4096;
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789";
const CODE_LEN = 8;
const DEFAULT_NAME = "my fly";

type Species = (typeof SPECIES)[number];
type Mood = (typeof MOODS)[number];
type Costume = (typeof COSTUMES)[number];
type HideField = (typeof HIDE_FIELDS)[number];

interface User {
  token: string;
  code: string;
  name: string;
  species: Species;
  costume: Costume;
  createdAt: number;
  team: string;
  level: number;
  xp: number;
  raceWins: number;
  hide: HideField[];
}

interface Presence {
  code: string;
  online: boolean;
  lastSeen: number;
  mood: Mood;
  cardsPerMin: number;
  sessionCards: number;
  sessionAgain: number;
}

interface RaceRow {
  days: number;
  reviews: number;
  trueRetention: number | null;
  updatedAt: number;
}

interface FriendRow {
  code: string;
  name: string;
  species: Species;
  costume: Costume;
  team: string | null;
  level: number | null;
  xp: number | null;
  raceWins: number;
  joinedAt: number;
  online: boolean;
  mood: Mood;
  cardsPerMin: number;
  lastSeen: number;
}

/** Shared profile fields accepted by register / heartbeat / rename. */
const PROFILE_FIELDS = ["name", "species", "costume", "team", "level", "xp", "raceWins", "hide"] as const;

interface ProfilePatch {
  name?: string;
  species?: Species;
  costume?: Costume;
  team?: string;
  level?: number;
  xp?: number;
  raceWins?: number;
  hide?: HideField[];
}

// ---------- small helpers ----------

class HttpError extends Error {
  constructor(public status: number, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS, ...headers },
  });
}

const nowS = (): number => Math.floor(Date.now() / 1000);

const kUser = (code: string) => `user:${code}`;
const kPres = (code: string) => `pres:${code}`;
const kFriends = (code: string) => `friends:${code}`;
const kRace = (code: string, week: string) => `race:${code}:${week}`;
const kTok = (hash: string) => `tok:${hash}`;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return hex(new Uint8Array(digest));
}

function newToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16))); // 32 hex chars
}

/** Unbiased CSPRNG code: 8 chars from A-Z2-9 (34 symbols; rejection sampling avoids modulo bias). */
function newCode(): string {
  let out = "";
  while (out.length < CODE_LEN) {
    const buf = crypto.getRandomValues(new Uint8Array(16));
    for (const b of buf) {
      if (b < 238 && out.length < CODE_LEN) out += CODE_ALPHABET[b % CODE_ALPHABET.length]; // 238 = 7 * 34
    }
  }
  return out;
}

/** Constant-time string equality (length is also compared without leaking timing on the content). */
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

/** ISO-8601 week key for a unix-seconds timestamp, computed in UTC (weeks start Monday). */
export function isoWeekKey(unixS: number): string {
  const d = new Date(unixS * 1000);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7; // Mon=1 .. Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // move to the Thursday of this ISO week
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const CODE_RE = /^[A-Z2-9]{8}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;

// ---------- validation ----------

type Obj = Record<string, unknown>;

function parseBodyObject(raw: string, allowed: readonly string[]): Obj {
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
  let body: unknown;
  try {
    body = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "body must be an object");
  for (const k of Object.keys(body as Obj)) {
    if (!allowed.includes(k)) throw new HttpError(400, `unknown field: ${k}`);
  }
  return body as Obj;
}

async function readBody(req: Request, allowed: readonly string[]): Promise<Obj> {
  const len = req.headers.get("content-length");
  if (len && Number(len) > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
  return parseBodyObject(await req.text(), allowed);
}

/** Strips control characters, trims, caps at 24 chars. Empty -> undefined. */
export function cleanName(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, "name must be a string");
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "").trim();
  if (s.length > MAX_NAME) throw new HttpError(400, `name must be at most ${MAX_NAME} characters`);
  return s === "" ? undefined : s;
}

function oneOf<T extends string>(v: unknown, list: readonly T[], field: string): T {
  if (typeof v !== "string" || !(list as readonly string[]).includes(v)) throw new HttpError(400, `invalid ${field}`);
  return v as T;
}

function num(v: unknown, field: string, min: number, max: number, integer = false): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `invalid ${field}`);
  if (integer && !Number.isInteger(v)) throw new HttpError(400, `invalid ${field}`);
  return v;
}

function parseCode(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "invalid code");
  const c = v.trim().toUpperCase();
  if (!CODE_RE.test(c)) throw new HttpError(400, "invalid code");
  return c;
}

function parseTeam(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "invalid team");
  const t = v.trim().toUpperCase();
  if (t.length > MAX_TEAM || !/^[A-Z0-9]*$/.test(t)) throw new HttpError(400, "invalid team");
  return t;
}

function parseHide(v: unknown): HideField[] {
  if (!Array.isArray(v) || v.length > HIDE_FIELDS.length) throw new HttpError(400, "invalid hide");
  const out: HideField[] = [];
  for (const h of v) {
    const f = oneOf(h, HIDE_FIELDS, "hide");
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** Validates the profile fields present in a body; absent fields are left undefined. */
function parseProfile(body: Obj): ProfilePatch {
  const p: ProfilePatch = {};
  const name = cleanName(body.name);
  if (name !== undefined) p.name = name;
  if (body.species !== undefined) p.species = oneOf(body.species, SPECIES, "species");
  if (body.costume !== undefined) p.costume = oneOf(body.costume, COSTUMES, "costume");
  if (body.team !== undefined && body.team !== null) p.team = parseTeam(body.team);
  if (body.level !== undefined) p.level = num(body.level, "level", 1, 999, true);
  if (body.xp !== undefined) p.xp = num(body.xp, "xp", 0, 10_000_000, true);
  if (body.raceWins !== undefined) p.raceWins = num(body.raceWins, "raceWins", 0, 100_000, true);
  if (body.hide !== undefined) p.hide = parseHide(body.hide);
  return p;
}

/** Applies a patch to a user; returns true when something changed. */
function applyProfile(user: User, p: ProfilePatch): boolean {
  let changed = false;
  for (const k of Object.keys(p) as (keyof ProfilePatch)[]) {
    const v = p[k];
    if (v === undefined) continue;
    const cur = user[k];
    const same = Array.isArray(v) ? Array.isArray(cur) && v.length === cur.length && v.every((x, i) => x === cur[i]) : cur === v;
    if (!same) {
      (user as unknown as Record<string, unknown>)[k] = v;
      changed = true;
    }
  }
  return changed;
}

/** Fills in defaults for rows written before the profile fields existed. */
function normalizeUser(u: User): User {
  u.team = typeof u.team === "string" ? u.team : "";
  u.level = typeof u.level === "number" ? u.level : 1;
  u.xp = typeof u.xp === "number" ? u.xp : 0;
  u.raceWins = typeof u.raceWins === "number" ? u.raceWins : 0;
  u.hide = Array.isArray(u.hide) ? u.hide : [];
  return u;
}

// ---------- storage ----------

async function getJSON<T>(env: Env, key: string): Promise<T | null> {
  return (await env.FLY.get(key, "json")) as T | null;
}

async function putJSON(env: Env, key: string, value: unknown, ttl?: number): Promise<void> {
  await env.FLY.put(key, JSON.stringify(value), ttl ? { expirationTtl: ttl } : undefined);
}

async function getUser(env: Env, code: string): Promise<User | null> {
  const u = await getJSON<User>(env, kUser(code));
  return u ? normalizeUser(u) : null;
}

async function getFriendCodes(env: Env, code: string): Promise<string[]> {
  return (await getJSON<string[]>(env, kFriends(code))) ?? [];
}

async function putFriendCodes(env: Env, code: string, codes: string[]): Promise<void> {
  if (codes.length === 0) await env.FLY.delete(kFriends(code));
  else await putJSON(env, kFriends(code), codes);
}

/** A friend row as seen by someone else: the user's `hide` list is honoured. `self` shows everything. */
function presenceRow(user: User, p: Presence | null, now: number, self = false): FriendRow {
  const hidden = (f: HideField) => !self && user.hide.includes(f);
  const online = !hidden("online") && !!p && p.online && now - p.lastSeen <= PRESENCE_TTL_S;
  return {
    code: user.code,
    name: user.name,
    species: user.species,
    costume: user.costume,
    team: hidden("team") ? null : user.team,
    level: hidden("level") ? null : user.level,
    xp: hidden("level") ? null : user.xp,
    raceWins: user.raceWins,
    joinedAt: user.createdAt,
    online,
    mood: online ? p!.mood : "offline",
    cardsPerMin: online ? p!.cardsPerMin : 0,
    lastSeen: hidden("online") ? 0 : p ? p.lastSeen : 0,
  };
}

async function friendRows(env: Env, code: string, now: number): Promise<FriendRow[]> {
  const codes = await getFriendCodes(env, code);
  const rows = await Promise.all(
    codes.map(async (c) => {
      const [u, p] = await Promise.all([getUser(env, c), getJSON<Presence>(env, kPres(c))]);
      return u ? presenceRow(u, p, now) : null;
    }),
  );
  return rows.filter((r): r is FriendRow => r !== null);
}

// ---------- auth + rate limiting ----------

function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/** Resolves the caller. Throws 401 on a missing/bad token. */
async function authenticate(env: Env, req: Request): Promise<User> {
  const token = bearer(req);
  if (!token || !TOKEN_RE.test(token)) throw new HttpError(401, "unauthorized");
  const code = await env.FLY.get(kTok(await sha256Hex(token)));
  const user = code ? await getUser(env, code) : null;
  // Always run the constant-time comparison so the response time does not depend on whether the token exists.
  const ok = timingSafeEqualStr(user?.token ?? "0".repeat(32), token);
  if (!user || !ok) throw new HttpError(401, "unauthorized");
  return user;
}

/** Fixed-window counter per identity (token hash, or client IP for unauthenticated calls). */
async function rateLimit(env: Env, id: string, now: number): Promise<void> {
  const minute = Math.floor(now / 60);
  const key = `rl:${id}:${minute}`;
  const count = Number((await env.FLY.get(key)) ?? "0") + 1;
  if (count > RATE_LIMIT_PER_MIN) {
    const retry = Math.max(1, (minute + 1) * 60 - now);
    throw new HttpError(429, "rate limited", { "Retry-After": String(retry) });
  }
  await env.FLY.put(key, String(count), { expirationTtl: 120 }); // KV's minimum TTL is 60 s
}

async function limitByToken(env: Env, req: Request, now: number): Promise<void> {
  const token = bearer(req);
  if (token) await rateLimit(env, "t:" + (await sha256Hex(token)).slice(0, 32), now);
  else await limitByIp(env, req, now);
}

async function limitByIp(env: Env, req: Request, now: number): Promise<void> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  await rateLimit(env, "ip:" + (await sha256Hex(ip)).slice(0, 32), now);
}

// ---------- handlers ----------

async function handleRegister(env: Env, req: Request, now: number): Promise<Response> {
  const body = await readBody(req, PROFILE_FIELDS);
  const patch = parseProfile(body);

  // Idempotent when a valid token is presented: return the existing code and update the profile.
  if (bearer(req)) {
    const user = await authenticate(env, req);
    if (applyProfile(user, patch)) await putJSON(env, kUser(user.code), user);
    return json({ token: user.token, code: user.code });
  }

  const token = newToken();
  let code = newCode();
  for (let i = 0; i < 20 && (await env.FLY.get(kUser(code))) !== null; i++) code = newCode();
  if ((await env.FLY.get(kUser(code))) !== null) throw new HttpError(503, "could not allocate a code, retry");

  const user: User = {
    token,
    code,
    name: DEFAULT_NAME,
    species: "wild",
    costume: "none",
    createdAt: now,
    team: "",
    level: 1,
    xp: 0,
    raceWins: 0,
    hide: [],
  };
  applyProfile(user, patch);
  await Promise.all([putJSON(env, kUser(code), user), env.FLY.put(kTok(await sha256Hex(token)), code)]);
  return json({ token, code }, 201);
}

async function handleHeartbeat(env: Env, req: Request, user: User, now: number): Promise<Response> {
  const body = await readBody(req, [...PROFILE_FIELDS, "mood", "cardsPerMin", "sessionCards", "sessionAgain", "race"]);
  const patch = parseProfile(body);
  const mood = body.mood === undefined ? "idle" : oneOf(body.mood, MOODS, "mood");
  const cardsPerMin = body.cardsPerMin === undefined ? 0 : num(body.cardsPerMin, "cardsPerMin", 0, 1000);
  const sessionCards = body.sessionCards === undefined ? 0 : num(body.sessionCards, "sessionCards", 0, 100000, true);
  const sessionAgain = body.sessionAgain === undefined ? 0 : num(body.sessionAgain, "sessionAgain", 0, 100000, true);

  let race: RaceRow | null = null;
  if (body.race !== undefined && body.race !== null) {
    const r = body.race;
    if (typeof r !== "object" || Array.isArray(r)) throw new HttpError(400, "invalid race");
    for (const k of Object.keys(r as Obj)) {
      if (!["days", "reviews", "trueRetention"].includes(k)) throw new HttpError(400, `unknown field: race.${k}`);
    }
    const ro = r as Obj;
    race = {
      days: ro.days === undefined ? 0 : num(ro.days, "race.days", 0, 10000, true),
      reviews: ro.reviews === undefined ? 0 : num(ro.reviews, "race.reviews", 0, 1000000, true),
      trueRetention: ro.trueRetention === undefined || ro.trueRetention === null ? null : num(ro.trueRetention, "race.trueRetention", 0, 100),
      updatedAt: now,
    };
  }

  const profileChanged = applyProfile(user, patch);

  const presence: Presence = {
    code: user.code,
    online: mood !== "offline",
    lastSeen: now,
    mood,
    cardsPerMin: round2(cardsPerMin),
    sessionCards,
    sessionAgain,
  };

  const writes: Promise<unknown>[] = [putJSON(env, kPres(user.code), presence, 60 * 60 * 24 * 30)];
  if (profileChanged) writes.push(putJSON(env, kUser(user.code), user));
  if (race) writes.push(putJSON(env, kRace(user.code, isoWeekKey(now)), race, 60 * 60 * 24 * 60));
  await Promise.all(writes);

  return json({ ok: true, friends: await friendRows(env, user.code, now) });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function handleAddFriend(env: Env, req: Request, user: User): Promise<Response> {
  const body = await readBody(req, ["code"]);
  const code = parseCode(body.code);
  if (code === user.code) throw new HttpError(400, "that is your own code");
  const friend = await getUser(env, code);
  if (!friend) throw new HttpError(404, "no fly with that code");

  const [mine, theirs] = await Promise.all([getFriendCodes(env, user.code), getFriendCodes(env, code)]);
  const already = mine.includes(code);
  if (!already) {
    if (mine.length >= MAX_FRIENDS) throw new HttpError(409, "you already have the maximum number of friends");
    if (theirs.length >= MAX_FRIENDS && !theirs.includes(user.code)) throw new HttpError(409, "that fly already has the maximum number of friends");
    mine.push(code);
  }
  const writes: Promise<unknown>[] = [];
  if (!already) writes.push(putFriendCodes(env, user.code, mine));
  if (!theirs.includes(user.code)) writes.push(putFriendCodes(env, code, [...theirs, user.code]));
  await Promise.all(writes);

  return json({ ok: true, friend: { code: friend.code, name: friend.name, species: friend.species, costume: friend.costume } });
}

async function handleRemoveFriend(env: Env, user: User, rawCode: string): Promise<Response> {
  const code = parseCode(decodeURIComponent(rawCode));
  const [mine, theirs] = await Promise.all([getFriendCodes(env, user.code), getFriendCodes(env, code)]);
  await Promise.all([
    putFriendCodes(env, user.code, mine.filter((c) => c !== code)),
    putFriendCodes(env, code, theirs.filter((c) => c !== user.code)),
  ]);
  return json({ ok: true });
}

async function handleListFriends(env: Env, user: User, now: number): Promise<Response> {
  return json({ ok: true, friends: await friendRows(env, user.code, now) });
}

async function handleRace(env: Env, url: URL, user: User, now: number): Promise<Response> {
  const week = url.searchParams.get("week") ?? isoWeekKey(now);
  if (!WEEK_RE.test(week)) throw new HttpError(400, "invalid week (expected e.g. 2026-W39)");
  const codes = [user.code, ...(await getFriendCodes(env, user.code))];
  const rows = await Promise.all(
    codes.map(async (c) => {
      const self = c === user.code;
      const [u, r] = await Promise.all([self ? user : getUser(env, c), getJSON<RaceRow>(env, kRace(c, week))]);
      if (!u) return null;
      const hidden = (f: HideField) => !self && u.hide.includes(f);
      return {
        code: u.code,
        name: u.name,
        species: u.species,
        costume: u.costume,
        team: hidden("team") ? null : u.team,
        level: hidden("level") ? null : u.level,
        xp: hidden("level") ? null : u.xp,
        raceWins: u.raceWins,
        joinedAt: u.createdAt,
        days: hidden("days") ? null : (r?.days ?? 0),
        reviews: hidden("weekly") ? null : (r?.reviews ?? 0),
        trueRetention: r?.trueRetention ?? null,
      };
    }),
  );
  const standings = rows
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => (b.days ?? -1) - (a.days ?? -1) || (b.trueRetention ?? -1) - (a.trueRetention ?? -1) || (b.reviews ?? -1) - (a.reviews ?? -1) || a.code.localeCompare(b.code));
  return json({ week, standings });
}

async function handleRename(env: Env, req: Request, user: User): Promise<Response> {
  const body = await readBody(req, PROFILE_FIELDS);
  const patch = parseProfile(body);
  if (Object.keys(patch).length === 0) throw new HttpError(400, "nothing to change (name is required or empty)");
  if (applyProfile(user, patch)) await putJSON(env, kUser(user.code), user);
  return json({ ok: true, name: user.name });
}

async function handleProfile(env: Env, user: User, rawCode: string, now: number): Promise<Response> {
  const code = parseCode(decodeURIComponent(rawCode));
  if (code === user.code) {
    return json({ ok: true, profile: presenceRow(user, await getJSON<Presence>(env, kPres(code)), now, true) });
  }
  const mine = await getFriendCodes(env, user.code);
  if (!mine.includes(code)) throw new HttpError(404, "not a friend");
  const [friend, p] = await Promise.all([getUser(env, code), getJSON<Presence>(env, kPres(code))]);
  if (!friend) throw new HttpError(404, "not a friend");
  return json({ ok: true, profile: presenceRow(friend, p, now) });
}

async function handleDeleteMe(env: Env, user: User): Promise<Response> {
  const code = user.code;
  const friends = await getFriendCodes(env, code);
  // Remove this code from every friend's list.
  await Promise.all(
    friends.map(async (f) => {
      const list = await getFriendCodes(env, f);
      if (list.includes(code)) await putFriendCodes(env, f, list.filter((c) => c !== code));
    }),
  );
  // Race rows for every week.
  const raceKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FLY.list({ prefix: `race:${code}:`, cursor });
    raceKeys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await Promise.all([
    env.FLY.delete(kTok(await sha256Hex(user.token))),
    env.FLY.delete(kUser(code)),
    env.FLY.delete(kPres(code)),
    env.FLY.delete(kFriends(code)),
    ...raceKeys.map((k) => env.FLY.delete(k)),
  ]);
  return json({ ok: true });
}

// ---------- router ----------

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();
  const now = nowS();

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (path === "/" || path === "/v1") return json({ ok: true, service: "anki-fly-friends", version: 1 });

  if (path === "/v1/register" && method === "POST") {
    await limitByToken(env, req, now);
    return await handleRegister(env, req, now);
  }

  if (!path.startsWith("/v1/")) throw new HttpError(404, "not found");

  // Everything else requires a token.
  await limitByToken(env, req, now);
  const user = await authenticate(env, req);

  if (path === "/v1/heartbeat" && method === "POST") return await handleHeartbeat(env, req, user, now);
  if (path === "/v1/friends" && method === "POST") return await handleAddFriend(env, req, user);
  if (path === "/v1/friends" && method === "GET") return await handleListFriends(env, user, now);
  const del = /^\/v1\/friends\/([^/]+)$/.exec(path);
  if (del && method === "DELETE") return await handleRemoveFriend(env, user, del[1]);
  if (path === "/v1/race" && method === "GET") return await handleRace(env, url, user, now);
  const prof = /^\/v1\/profile\/([^/]+)$/.exec(path);
  if (prof && method === "GET") return await handleProfile(env, user, prof[1], now);
  if (path === "/v1/rename" && method === "POST") return await handleRename(env, req, user);
  if (path === "/v1/me" && method === "DELETE") return await handleDeleteMe(env, user);

  throw new HttpError(404, "not found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status, e.headers);
      console.error(e);
      return json({ ok: false, error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
