# Drosophil-Anki friends backend (spec / prompt for building it)

Paste everything below the line into your coding agent. It is self-contained.

---

Build a small, free-tier-friendly backend for "Drosophil-Anki", an Anki add-on where each user has a
virtual fruit fly. The backend lets users add friends by code, see whether friends are studying right
now (and their fly's mood), and run a weekly "fly race". No accounts, no emails, no passwords: a
user is identified by a random secret token the add-on generates; a public 8-character **fly code**
is what people share.

## Stack
Cloudflare Worker (TypeScript) + Cloudflare KV (or D1 if you prefer SQL). Single `wrangler.toml`,
deployable with `wrangler deploy`. Include a README with deploy steps and the base URL placeholder
`https://<name>.workers.dev`. No third-party services. CORS: allow `*` (the add-on calls from a
`http://127.0.0.1:<port>` origin inside Anki). All responses JSON. Rate limit by token: 60 req/min.

## Data model
```
User { token (secret, 32 hex), code (public, 8 chars, A-Z2-9), name (<=24), species, createdAt }
Presence { code, online (bool), lastSeen (unix s), mood (string), cardsPerMin (float), sessionCards (int), sessionAgain (int) }
Friends { code -> Set<code> }   // symmetric: adding a friend adds both directions
Race { weekKey "2026-W39", code -> { days: int, reviews: int, trueRetention: float|null, updatedAt } }
```
Presence expires: `online` is true only if `lastSeen` is within 120 s.

## Endpoints
- `POST /v1/register` body `{ name?, species? }` → `{ token, code }`. Creates a user. Idempotent per
  token if `Authorization: Bearer <token>` is sent (then returns the existing code and updates name/species).
- `POST /v1/heartbeat` auth Bearer. body `{ name, species, mood, cardsPerMin, sessionCards, sessionAgain, race: { days, reviews, trueRetention } }`
  → `{ ok: true, friends: [ { code, name, species, online, mood, cardsPerMin, lastSeen } ] }`.
  Called every 30 s while Anki is open (and once on close with `mood: "offline"` which sets online=false).
  Stores presence and the caller's race stats for the current ISO week (Monday start, UTC).
- `POST /v1/friends` auth Bearer. body `{ code }` → adds the friend symmetrically. `{ ok, friend: {code,name,species} }`.
  404 if unknown. Max 50 friends. `DELETE /v1/friends/:code` removes both directions.
- `GET /v1/friends` auth Bearer → same friend list as heartbeat returns.
- `GET /v1/race?week=2026-W39` auth Bearer → `{ week, standings: [ { code, name, species, days, reviews, trueRetention } ] }`
  for the caller and their friends, sorted by days desc, then trueRetention desc, then reviews desc.
- `POST /v1/rename` auth Bearer body `{ name }`.
- `DELETE /v1/me` auth Bearer → deletes the user, presence, race rows and removes them from friends' lists.

## Rules
- Never store or accept card content, deck names, or note text. Reject bodies with unknown fields.
- Validate: name ≤ 24 chars (strip control chars), species in `[wild, white, ebony, yellow, female]`,
  mood in a short allowlist (`study, pressAgain, pressHard, pressGood, pressEasy, celebrate, dance,
  zoomies, crashout, sulk, sleepDesk, still, idle, offline`), numbers finite and within sane bounds.
- Tokens are compared in constant time. Codes are generated from a CSPRNG, retry on collision.
- Return `429` with `Retry-After` when rate limited; `401` on bad token.
- Write tests (vitest with `unstable_dev` or Miniflare) for register → heartbeat → friends → race.
- Provide a short `PRIVACY.md`: what is stored (name, species, mood, aggregate study counts), how to
  delete (`DELETE /v1/me`, exposed in the add-on as "Leave friends"), no analytics, no third parties.

## Add-on side (for context; not part of this task)
The add-on will: generate/store the token in `user_files/state.json`, show the fly code in its menu,
send heartbeats while reviewing, render online friends' flies at a second desk in the widget from
`friends[].mood`, and show the weekly race in the Fly Exam window.
