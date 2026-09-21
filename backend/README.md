# Drosophil-Anki friends backend

A small Cloudflare Worker + KV service for the Drosophil-Anki add-on: friends by fly code, "is my friend
studying right now" presence, and a weekly fly race. No accounts, no emails, no passwords: a user is a random
secret token the add-on generates; the public 8-character **fly code** is what people share. Free-tier friendly
(one Worker, one KV namespace, no third-party services). See `PRIVACY.md` for what is stored.

The full behaviour is specified in [`../docs/backend-spec.md`](../docs/backend-spec.md).

## Deploy

Requires Node 18+ and a Cloudflare account (the free plan is enough).

```sh
cd backend
npm install
npx wrangler login
npx wrangler kv namespace create FLY
```

The last command prints something like:

```
[[kv_namespaces]]
binding = "FLY"
id = "0123456789abcdef0123456789abcdef"
```

Paste that `id` into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`. Then:

```sh
npx wrangler deploy
```

Wrangler prints the base URL, `https://<name>.workers.dev` (the `<name>` is `anki-fly-friends` unless you change
`name` in `wrangler.toml`). Put that URL in the add-on config as `friends_server`
(Anki: Tools > Add-ons > Drosophil-Anki > Config), for example:

```json
{ "friends_server": "https://anki-fly-friends.<your-subdomain>.workers.dev" }
```

`GET https://<name>.workers.dev/` answers `{"ok":true,...}` so you can check it is up.

## Develop / test

```sh
npm test          # vitest, runs the Worker in workerd via @cloudflare/vitest-pool-workers
npm run typecheck
npm run dev       # local server on http://localhost:8787 with a local KV
```

## API

All responses are JSON and carry `Access-Control-Allow-Origin: *`. Authenticated routes take
`Authorization: Bearer <token>`; a bad or missing token is `401`. Each token (or, for unauthenticated
registration, each client IP) gets 60 requests per minute; over that the reply is `429` with a `Retry-After`
header. Bodies with unknown fields are rejected with `400` (card content, deck names and note text are never
accepted).

| Method | Path | Body | Reply |
| --- | --- | --- | --- |
| POST | `/v1/register` | `{ name?, species?, costume? }` | `201 { token, code }`. With a valid Bearer token it is idempotent: `200` with the existing code, profile updated. |
| POST | `/v1/heartbeat` | `{ name, species, costume, mood, cardsPerMin, sessionCards, sessionAgain, race: { days, reviews, trueRetention } }` | `{ ok, friends: [ { code, name, species, costume, online, mood, cardsPerMin, lastSeen } ] }`. `mood: "offline"` marks you offline at once. |
| GET | `/v1/friends` | | Same friend list as heartbeat. |
| POST | `/v1/friends` | `{ code }` | `{ ok, friend: { code, name, species, costume } }`; `404` unknown code; `409` when either side already has 50 friends. Friendship is symmetric. |
| DELETE | `/v1/friends/:code` | | `{ ok }`; removes both directions. |
| GET | `/v1/race?week=2026-W39` | | `{ week, standings: [ { code, name, species, costume, days, reviews, trueRetention } ] }` for you and your friends, sorted by days, then trueRetention, then reviews (all descending). `week` defaults to the current ISO week (UTC, Monday start). |
| POST | `/v1/rename` | `{ name }` | `{ ok, name }` |
| DELETE | `/v1/me` | | `{ ok }`; deletes the user, presence, race rows and removes them from every friend list. |

Validation: `name` at most 24 characters after stripping control characters; `species` one of
`wild, white, ebony, yellow, female`; `costume` one of `none` plus the 23 wardrobe names in
`addon/web/costumes.js`; `mood` one of `study, pressAgain, pressHard, pressGood, pressEasy, celebrate, dance,
zoomies, crashout, sulk, sleepDesk, still, idle, offline`; numbers must be finite and within sane bounds
(`cardsPerMin` 0-1000, counts non-negative integers, `trueRetention` 0-100 or null).

Presence: `online` is true only when the last heartbeat was within 120 s and was not `mood: "offline"`.
`lastSeen` is unix seconds (0 if the user never sent a heartbeat).

## Storage layout (KV namespace `FLY`)

```
tok:<sha256(token)>    -> code            token index; the token itself is compared in constant time
user:<code>            -> { token, code, name, species, costume, createdAt }
pres:<code>            -> { code, online, lastSeen, mood, cardsPerMin, sessionCards, sessionAgain }
friends:<code>         -> [code, ...]     kept symmetric
race:<code>:<weekKey>  -> { days, reviews, trueRetention, updatedAt }
rl:<id>:<minute>       -> count           rate-limit window, expires by itself
```

KV is eventually consistent across regions, so the rate limit and the "add friend" bookkeeping are
best-effort under concurrent writes; that is fine for a 30-second heartbeat.
