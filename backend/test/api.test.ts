import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isoWeekKey, PRESENCE_TTL_S, RATE_LIMIT_PER_MIN } from "../src/index";

const BASE = "https://fly.test";

// Every test registers fresh users from the same fake IP; reset the fixed-window counters between tests.
beforeEach(async () => {
  const { keys } = await env.FLY.list({ prefix: "rl:" });
  await Promise.all(keys.map((k) => env.FLY.delete(k.name)));
});

async function call(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await SELF.fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function register(name: string, species = "wild", costume = "none") {
  const r = await call("POST", "/v1/register", { name, species, costume });
  expect(r.status).toBe(201);
  expect(r.body.token).toMatch(/^[0-9a-f]{32}$/);
  expect(r.body.code).toMatch(/^[A-Z2-9]{8}$/);
  return r.body as { token: string; code: string };
}

/** The exact body addon/friends.py sends. */
function heartbeatBody(over: Record<string, unknown> = {}) {
  return {
    name: "my fly", species: "female", costume: "sunglasses", mood: "study",
    cardsPerMin: 4.2, sessionCards: 12, sessionAgain: 2,
    race: { days: 3, reviews: 12, trueRetention: null },
    ...over,
  };
}

describe("register", () => {
  it("creates a user and is idempotent with a token", async () => {
    const a = await register("Alice", "female", "partyhat");
    const again = await call("POST", "/v1/register", { name: "Alice 2" }, a.token);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ token: a.token, code: a.code });
    const list = await call("GET", "/v1/friends", undefined, a.token);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ ok: true, friends: [] });
  });

  it("validates and rejects unknown fields", async () => {
    expect((await call("POST", "/v1/register", { name: "x", deck: "Biology" })).status).toBe(400);
    expect((await call("POST", "/v1/register", { species: "mosquito" })).status).toBe(400);
    expect((await call("POST", "/v1/register", { costume: "cape" })).status).toBe(400);
    expect((await call("POST", "/v1/register", { name: "a".repeat(25) })).status).toBe(400);
    const ok = await call("POST", "/v1/register", { name: " Bob\u0000\u0007 " });
    expect(ok.status).toBe(201);
  });

  it("rejects bad tokens with 401", async () => {
    expect((await call("GET", "/v1/friends")).status).toBe(401);
    expect((await call("GET", "/v1/friends", undefined, "0".repeat(32))).status).toBe(401);
    expect((await call("GET", "/v1/friends", undefined, "not-hex")).status).toBe(401);
  });

  it("answers CORS preflight and sets Access-Control-Allow-Origin: *", async () => {
    const pre = await SELF.fetch(BASE + "/v1/heartbeat", { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:40000" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const r = await call("GET", "/v1/friends");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("heartbeat + friends + presence", () => {
  it("register -> heartbeat -> add friend both directions -> presence online/offline", async () => {
    const a = await register("Alice");
    const b = await register("Bob", "wild", "none");

    // Heartbeat with the add-on's exact body shape; friends list is empty at first.
    const hb = await call("POST", "/v1/heartbeat", heartbeatBody(), a.token);
    expect(hb.status).toBe(200);
    expect(hb.body).toEqual({ ok: true, friends: [] });

    // Unknown code -> 404, own code -> 400, unknown body field -> 400.
    expect((await call("POST", "/v1/friends", { code: "ZZZZZZZZ" }, a.token)).status).toBe(404);
    expect((await call("POST", "/v1/friends", { code: a.code }, a.token)).status).toBe(400);
    expect((await call("POST", "/v1/friends", { code: b.code, note: "hi" }, a.token)).status).toBe(400);

    // Alice adds Bob (lower-case, padded input is normalised).
    const add = await call("POST", "/v1/friends", { code: ` ${b.code.toLowerCase()} ` }, a.token);
    expect(add.status).toBe(200);
    expect(add.body).toEqual({ ok: true, friend: { code: b.code, name: "Bob", species: "wild", costume: "none" } });

    // Symmetric: Bob sees Alice too, with Alice's live profile/presence from her heartbeat.
    const bobList = await call("GET", "/v1/friends", undefined, b.token);
    expect(bobList.body.friends).toHaveLength(1);
    const aliceRow = bobList.body.friends[0];
    expect(aliceRow).toMatchObject({ code: a.code, name: "my fly", species: "female", costume: "sunglasses", online: true, mood: "study", cardsPerMin: 4.2 });
    expect(Object.keys(aliceRow).sort()).toEqual(["cardsPerMin", "code", "costume", "joinedAt", "lastSeen", "level", "mood", "name", "online", "raceWins", "species", "team", "xp"]);
    expect(aliceRow).toMatchObject({ team: "", level: 1, xp: 0, raceWins: 0 });
    expect(Math.abs(aliceRow.joinedAt - Date.now() / 1000)).toBeLessThan(5);
    expect(typeof aliceRow.lastSeen).toBe("number");
    expect(Math.abs(aliceRow.lastSeen - Date.now() / 1000)).toBeLessThan(5); // unix seconds

    // Bob has never heartbeated: offline, lastSeen 0.
    const aliceList = await call("POST", "/v1/heartbeat", heartbeatBody(), a.token);
    expect(aliceList.body.friends[0]).toMatchObject({ code: b.code, online: false, mood: "offline", cardsPerMin: 0, lastSeen: 0 });

    // Adding again is a no-op (no duplicates).
    expect((await call("POST", "/v1/friends", { code: b.code }, a.token)).status).toBe(200);
    expect((await call("GET", "/v1/friends", undefined, a.token)).body.friends).toHaveLength(1);

    // Bob goes online, then sends the on-close heartbeat -> offline immediately.
    await call("POST", "/v1/heartbeat", heartbeatBody({ mood: "dance", species: "wild", costume: "crown" }), b.token);
    let row = (await call("GET", "/v1/friends", undefined, a.token)).body.friends[0];
    expect(row).toMatchObject({ online: true, mood: "dance", costume: "crown" });
    await call("POST", "/v1/heartbeat", heartbeatBody({ mood: "offline" }), b.token);
    row = (await call("GET", "/v1/friends", undefined, a.token)).body.friends[0];
    expect(row).toMatchObject({ online: false, mood: "offline", cardsPerMin: 0 });
    expect(row.lastSeen).toBeGreaterThan(0);

    // Presence expires after 120 s without a heartbeat (simulate an old lastSeen in KV).
    await call("POST", "/v1/heartbeat", heartbeatBody({ mood: "study" }), b.token);
    const pres = JSON.parse((await env.FLY.get(`pres:${b.code}`))!);
    expect(pres.online).toBe(true);
    pres.lastSeen = Math.floor(Date.now() / 1000) - PRESENCE_TTL_S - 1;
    await env.FLY.put(`pres:${b.code}`, JSON.stringify(pres));
    row = (await call("GET", "/v1/friends", undefined, a.token)).body.friends[0];
    expect(row).toMatchObject({ online: false, mood: "offline", lastSeen: pres.lastSeen });

    // Removing a friend removes both directions.
    const del = await call("DELETE", `/v1/friends/${b.code}`, undefined, a.token);
    expect(del.status).toBe(200);
    expect((await call("GET", "/v1/friends", undefined, a.token)).body.friends).toEqual([]);
    expect((await call("GET", "/v1/friends", undefined, b.token)).body.friends).toEqual([]);
  });

  it("validates heartbeat fields and rejects card content", async () => {
    const a = await register("Alice");
    const bad = async (over: Record<string, unknown>) => (await call("POST", "/v1/heartbeat", heartbeatBody(over), a.token)).status;
    expect(await bad({ mood: "angry" })).toBe(400);
    expect(await bad({ cardsPerMin: -1 })).toBe(400);
    expect(await bad({ cardsPerMin: "fast" })).toBe(400);
    expect(await bad({ sessionCards: 1.5 })).toBe(400);
    expect(await bad({ race: { days: 3, reviews: 1, trueRetention: 1.5, deckName: "x" } })).toBe(400);
    expect(await bad({ race: { days: -1, reviews: 1, trueRetention: null } })).toBe(400);
    expect(await bad({ noteText: "the mitochondria" })).toBe(400);
    const nan = await SELF.fetch(BASE + "/v1/heartbeat", {
      method: "POST", headers: { Authorization: `Bearer ${a.token}` }, body: '{"cardsPerMin": 1e999}',
    });
    expect(nan.status).toBe(400);
    expect((await call("POST", "/v1/heartbeat", {}, a.token)).status).toBe(200);
  });

  it("rename updates the name friends see", async () => {
    const a = await register("Alice");
    const b = await register("Bob");
    await call("POST", "/v1/friends", { code: b.code }, a.token);
    expect((await call("POST", "/v1/rename", { name: "" }, b.token)).status).toBe(400);
    expect((await call("POST", "/v1/rename", { name: "Robert" }, b.token)).status).toBe(200);
    expect((await call("GET", "/v1/friends", undefined, a.token)).body.friends[0].name).toBe("Robert");
  });

  it("caps friends at 50", async () => {
    const a = await register("Alice");
    const codes: string[] = [];
    for (let i = 0; i < 50; i++) codes.push((await register(`F${i}`)).code);
    await env.FLY.put(`friends:${a.code}`, JSON.stringify(codes));
    const extra = await register("Extra");
    expect((await call("POST", "/v1/friends", { code: extra.code }, a.token)).status).toBe(409);
    expect((await call("POST", "/v1/friends", { code: a.code }, extra.token)).status).toBe(409);
  });
});

describe("race", () => {
  it("computes ISO week keys in UTC with a Monday start", () => {
    expect(isoWeekKey(Date.UTC(2026, 8, 21) / 1000)).toBe("2026-W39"); // Mon 21 Sep 2026
    expect(isoWeekKey(Date.UTC(2026, 8, 20, 23, 59) / 1000)).toBe("2026-W38"); // Sun 20 Sep 2026
    expect(isoWeekKey(Date.UTC(2027, 0, 1) / 1000)).toBe("2026-W53"); // 1 Jan 2027 is in ISO week 53 of 2026
    expect(isoWeekKey(Date.UTC(2024, 11, 30) / 1000)).toBe("2025-W01"); // 30 Dec 2024 is in 2025-W01
  });

  it("returns standings for me and my friends, sorted by days, retention, reviews", async () => {
    const a = await register("Alice");
    const b = await register("Bob");
    const c = await register("Cara");
    const stranger = await register("Stranger");
    await call("POST", "/v1/friends", { code: b.code }, a.token);
    await call("POST", "/v1/friends", { code: c.code }, a.token);

    await call("POST", "/v1/heartbeat", heartbeatBody({ race: { days: 3, reviews: 100, trueRetention: 0.9 } }), a.token);
    await call("POST", "/v1/heartbeat", heartbeatBody({ race: { days: 5, reviews: 10, trueRetention: null } }), b.token);
    await call("POST", "/v1/heartbeat", heartbeatBody({ race: { days: 3, reviews: 200, trueRetention: 0.8 } }), c.token);
    await call("POST", "/v1/heartbeat", heartbeatBody({ race: { days: 9, reviews: 999, trueRetention: 1 } }), stranger.token);

    const week = isoWeekKey(Math.floor(Date.now() / 1000));
    const r = await call("GET", "/v1/race", undefined, a.token);
    expect(r.status).toBe(200);
    expect(r.body.week).toBe(week);
    expect(r.body.standings.map((s: { code: string }) => s.code)).toEqual([b.code, a.code, c.code]);
    expect(r.body.standings[1]).toMatchObject({ code: a.code, name: "my fly", species: "female", costume: "sunglasses", days: 3, reviews: 100, trueRetention: 0.9, team: "", level: 1, xp: 0, raceWins: 0 });
    expect(typeof r.body.standings[1].joinedAt).toBe("number");

    // Explicit week query; an empty week gives zero rows; a malformed one is rejected.
    expect((await call("GET", `/v1/race?week=${week}`, undefined, a.token)).body.standings).toHaveLength(3);
    const empty = await call("GET", "/v1/race?week=2020-W01", undefined, a.token);
    expect(empty.body.standings.every((s: { days: number }) => s.days === 0)).toBe(true);
    expect((await call("GET", "/v1/race?week=2026-39", undefined, a.token)).status).toBe(400);
  });
});

describe("rate limit", () => {
  it("returns 429 with Retry-After after 60 requests in a minute", async () => {
    const a = await register("Alice");
    // register consumed the IP bucket, not the token bucket; the token bucket starts fresh here.
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) {
      expect((await call("GET", "/v1/friends", undefined, a.token)).status).toBe(200);
    }
    const limited = await call("GET", "/v1/friends", undefined, a.token);
    expect(limited.status).toBe(429);
    const retry = Number(limited.headers.get("Retry-After"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    // Another user is unaffected.
    const b = await register("Bob");
    expect((await call("GET", "/v1/friends", undefined, b.token)).status).toBe(200);
  });
});

describe("delete me", () => {
  it("removes user, presence, race rows, friend links and the token", async () => {
    const a = await register("Alice");
    const b = await register("Bob");
    await call("POST", "/v1/friends", { code: b.code }, a.token);
    await call("POST", "/v1/heartbeat", heartbeatBody(), a.token);
    expect((await env.FLY.list({ prefix: `race:${a.code}:` })).keys).toHaveLength(1);

    const del = await call("DELETE", "/v1/me", undefined, a.token);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    expect((await call("GET", "/v1/friends", undefined, a.token)).status).toBe(401);
    expect((await call("GET", "/v1/friends", undefined, b.token)).body.friends).toEqual([]);
    expect((await call("POST", "/v1/friends", { code: a.code }, b.token)).status).toBe(404);
    expect(await env.FLY.get(`user:${a.code}`)).toBeNull();
    expect(await env.FLY.get(`pres:${a.code}`)).toBeNull();
    expect(await env.FLY.get(`friends:${a.code}`)).toBeNull();
    expect((await env.FLY.list({ prefix: `race:${a.code}:` })).keys).toHaveLength(0);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(a.token))), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(await env.FLY.get(`tok:${hash}`)).toBeNull();
  });
});

describe("profile fields, hide and GET /v1/profile/:code", () => {
  it("stores team/level/xp/raceWins/hide via register, heartbeat and rename", async () => {
    const a = await call("POST", "/v1/register", { name: "Alice", team: " med1 ", level: 7, xp: 1234, raceWins: 2, hide: ["level"] });
    expect(a.status).toBe(201);
    const b = await register("Bob");
    await call("POST", "/v1/friends", { code: b.code }, a.body.token);

    // Own row is always complete.
    const me = await call("GET", `/v1/profile/${a.body.code}`, undefined, a.body.token);
    expect(me.status).toBe(200);
    expect(me.body.profile).toMatchObject({ code: a.body.code, team: "MED1", level: 7, xp: 1234, raceWins: 2 });

    // Bob sees team but not level/xp.
    let seen = (await call("GET", `/v1/profile/${a.body.code}`, undefined, b.token)).body.profile;
    expect(seen).toMatchObject({ team: "MED1", level: null, xp: null, raceWins: 2 });

    // heartbeat updates the fields; rename accepts them too.
    await call("POST", "/v1/heartbeat", heartbeatBody({ level: 8, xp: 2000, hide: ["team"] }), a.body.token);
    seen = (await call("GET", "/v1/friends", undefined, b.token)).body.friends[0];
    expect(seen).toMatchObject({ team: null, level: 8, xp: 2000 });
    expect((await call("POST", "/v1/rename", { name: "Al", raceWins: 3, hide: [] }, a.body.token)).status).toBe(200);
    seen = (await call("GET", "/v1/friends", undefined, b.token)).body.friends[0];
    expect(seen).toMatchObject({ name: "Al", team: "MED1", level: 8, xp: 2000, raceWins: 3 });
  });

  it("validates the profile fields", async () => {
    const a = await register("Alice");
    const bad = async (over: Record<string, unknown>) => (await call("POST", "/v1/rename", { name: "x", ...over }, a.token)).status;
    expect(await bad({ team: "TOOLONG" })).toBe(400);
    expect(await bad({ team: "a-b" })).toBe(400);
    expect(await bad({ level: 0 })).toBe(400);
    expect(await bad({ level: 1000 })).toBe(400);
    expect(await bad({ level: 1.5 })).toBe(400);
    expect(await bad({ xp: -1 })).toBe(400);
    expect(await bad({ xp: 10_000_001 })).toBe(400);
    expect(await bad({ raceWins: 100_001 })).toBe(400);
    expect(await bad({ hide: ["secret"] })).toBe(400);
    expect(await bad({ hide: "level" })).toBe(400);
    expect(await bad({ hide: ["level", "weekly", "days", "team", "online", "level"] })).toBe(400);
    expect(await bad({ team: "", hide: ["level", "weekly", "days", "team", "online"] })).toBe(200);
    expect((await call("POST", "/v1/register", { costume: "stethoscope" })).status).toBe(201);
    expect((await call("POST", "/v1/register", { costume: "dictionary" })).status).toBe(201);
    expect((await call("POST", "/v1/register", { costume: "labcoat" })).status).toBe(400);
  });

  it("hide: online / days / weekly are honoured in friend rows and standings", async () => {
    const a = await register("Alice");
    const b = await register("Bob");
    await call("POST", "/v1/friends", { code: b.code }, a.token);
    await call("POST", "/v1/heartbeat", heartbeatBody({ mood: "dance", race: { days: 4, reviews: 40, trueRetention: 0.5 } }), b.token);

    let row = (await call("GET", "/v1/friends", undefined, a.token)).body.friends[0];
    expect(row).toMatchObject({ online: true, mood: "dance", cardsPerMin: 4.2 });
    expect(row.lastSeen).toBeGreaterThan(0);

    await call("POST", "/v1/heartbeat", heartbeatBody({ mood: "dance", hide: ["online", "days", "weekly"], race: { days: 4, reviews: 40, trueRetention: 0.5 } }), b.token);
    row = (await call("GET", "/v1/friends", undefined, a.token)).body.friends[0];
    expect(row).toMatchObject({ online: false, mood: "offline", cardsPerMin: 0, lastSeen: 0 });

    const st = (await call("GET", "/v1/race", undefined, a.token)).body.standings;
    const bob = st.find((s: { code: string }) => s.code === b.code);
    expect(bob).toMatchObject({ days: null, reviews: null, trueRetention: 0.5 });
    // Bob still sees his own full standings row.
    const own = (await call("GET", "/v1/race", undefined, b.token)).body.standings.find((s: { code: string }) => s.code === b.code);
    expect(own).toMatchObject({ days: 4, reviews: 40 });
    // And his own profile row.
    expect((await call("GET", `/v1/profile/${b.code}`, undefined, b.token)).body.profile).toMatchObject({ online: true, mood: "dance" });
  });

  it("GET /v1/profile/:code is 404 for strangers and unknown codes", async () => {
    const a = await register("Alice");
    const stranger = await register("S");
    expect((await call("GET", `/v1/profile/${stranger.code}`, undefined, a.token)).status).toBe(404);
    expect((await call("GET", "/v1/profile/ZZZZZZZZ", undefined, a.token)).status).toBe(404);
    expect((await call("GET", "/v1/profile/bad", undefined, a.token)).status).toBe(400);
  });
});
