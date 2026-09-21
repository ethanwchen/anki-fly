# Privacy

The Drosophil-Anki friends service exists so you can see whether your friends' flies are studying and run a
weekly fly race. It is designed to know as little as possible.

## What is stored

Per user, identified only by a random secret token and a public 8-character fly code:

- the fly's name (up to 24 characters), species and costume;
- presence: whether you are online, the time of the last heartbeat, and the fly's current mood
  (for example `study`, `celebrate`, `sulk`, `offline`);
- aggregate study counts for the current session (cards per minute, cards answered, "again" presses);
- weekly race stats: days studied, reviews, and true retention (a percentage or nothing);
- the list of fly codes you are friends with.

Nothing else. Card content, deck names, note text, email addresses, real names, Anki profile names and IP
addresses are never accepted or stored. Requests carrying unexpected fields are rejected. (Cloudflare, which
hosts the Worker, sees connection metadata like any web host; the Worker only uses the client IP transiently
to rate-limit unauthenticated registration and does not write it to storage.)

## Who can see it

Only people who have your fly code and whom you have added as a friend (friendship is mutual) see your name,
species, costume, mood, cards per minute and race stats. There is no directory or search.

## How to delete

In Anki choose Tools > Drosophil-Anki > **Leave friends**. That calls `DELETE /v1/me`, which erases your
user record, presence, race rows and friend list, and removes you from your friends' lists. Presence and race
rows also expire on their own (30 and 60 days after the last write).

## No analytics, no third parties

The service uses no analytics, no tracking, no advertising and no third-party services. It runs on a single
Cloudflare Worker with Cloudflare KV storage operated by whoever deployed it.
