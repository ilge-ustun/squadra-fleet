# Browser verification — post-005 persistence, 17 Sep 2026

Manual observation run. Purpose: settle whether a `fromCache: true` snapshot
precedes the server snapshot, which decides story 006's AC3, and tick story
005's human-verification checklist.

## Environment

| | |
|---|---|
| Base | `feat/pwa` after 005 merge (19 files / 100 tests green) |
| Build | `npm run build && npm run start`, production build |
| Origin | `http://localhost:3000` on local Mac — **not** the deployed origin |
| Install state | browser tab, **not** installed as PWA |
| Instrumentation | temporary `console.log` at both `onSnapshot` callbacks in `src/AppContext.tsx`, reverted after the run, never committed |

Logged per snapshot: `metadata.fromCache`, `metadata.hasPendingWrites`,
`docs.length`, `Date.now()`.

Caveat on scope: a localhost tab means `matchMedia("(display-mode:
standalone)")` is false, so the D-03 durable-storage branch never ran. That
part of 005's checklist still needs the deployed origin.

---

## Run 1 — cold load (site data cleared)

`01-cold-load-console.png`

    [SNAP songCollections]  fromCache: false  pending: false  docs: 47   t: 1789640735026
    [SNAP songs]            fromCache: false  pending: false  docs: 359  t: 1789640735028

One snapshot per listener, both authoritative, 2 ms apart. No cache-first
snapshot — nothing was cached to serve.

## IndexedDB after run 1

`02-indexeddb-store.png`

`firestore/[DEFAULT]/...` present with the full object-store set:
`remoteDocuments`, `mutations`, `mutationQueues`, `indexEntries`,
`indexState`, `documentOverlays`, `collectionParents`, `owner`,
`clientMetadata`, `bundles`, `namedQueries`, `globals`.

`clientMetadata` and `owner` are the multi-tab lease tables, so
`persistentMultipleTabManager` is active.

**This store did not exist before 005.** The SDK was silently on the memory
cache. This is the observable consequence of the fix, as distinct from the
unit test, which proves only the call shape.

## Run 2 — warm reload

`03-warm-reload-console.png`

    [SNAP songCollections]  fromCache: true  pending: false  docs: 47   t: 1789640926467
    [SNAP songs]            fromCache: true  pending: false  docs: 359  t: 1789640926590

**One snapshot per listener. No `fromCache: false` snapshot followed.**

Two findings:

1. The cache-before-server sequence is real. The rationale written at the
   `songs` listener (`~line 85`) was correct. It had never actually occurred
   before 005, because there was no persistent cache — the guard has been
   dead code for its entire life and is live as of the 005 merge.
2. When cached data is already current, the server does **not** emit a second
   snapshot. Anything waiting for `!fromCache` therefore never fires on a warm
   reload. This affects `setSongsLoaded(true)`, which falls through to its 4 s
   `setTimeout` instead.

   Checked for user-visible effect: **none observed.** Songs render from
   `allSongs`, populated before the guard. `songsLoaded` is simply wrong for
   ~4 s on every warm load with no consumer that notices. Recorded, not fixed.

## Run 3 — offline reload (DevTools → Network → Offline)

`04-offline-reload-console.png`

    [SNAP songCollections]  fromCache: true  pending: false  docs: 47   t: 1789641081187
    [SNAP songs]            fromCache: true  pending: false  docs: 359  t: 1789641081325

Full data served from IndexedDB with no network. Firestore's `Listen` channel
errors as expected (`code=unavailable`) and does not block the cached read.

---

## Results against the questions asked

| Question | Answer |
|---|---|
| Does a `fromCache: true` snapshot precede the server snapshot? | **Yes**, on warm and offline loads |
| Does a second `fromCache: false` snapshot follow it? | **No**, when cached data is current |
| Was a `fromCache: true` snapshot with `docs: 0` ever observed? | **No**, in any of the three runs |
| Does IndexedDB persist across reload? | **Yes** |
| Does offline read work? | **Yes** |

**Consequence for story 006:** AC3 (a `fromCache` guard on the clearing path)
is *not* justified by this evidence. The destructive input — a cached snapshot
carrying zero docs — never appeared. 006 ships the reverse-race lift with AC1
and AC2 only; the `fromCache` dimension is recorded as unobserved rather than
ruled out.

**Story 005 checklist:** items 1–3 (store exists, persists across reload,
offline read renders) satisfied on a localhost origin in a browser tab. Item 4
(installed PWA, durable storage) still outstanding — needs the deployed origin.

---

## New finding — offline routing is broken (not a Firestore problem)

Visible in `04-offline-reload-console.png`. Every Next.js RSC payload request
fails:

    GET /collections/circle?_rsc=...         net::ERR_INTERNET_DISCONNECTED
    GET /collections/mekhor/M3?_rsc=...      net::ERR_INTERNET_DISCONNECTED
    GET /collections/mekhor/M2?_rsc=...      net::ERR_INTERNET_DISCONNECTED
    GET /collections/dzamlinggar?_rsc=...    net::ERR_INTERNET_DISCONNECTED
    ... and the rest of the collection routes

Observed behaviour: offline, every collection URL renders the *first*
collection regardless of the address bar. The route cannot resolve, so the app
shows whatever client state is already mounted.

The split is clean and worth stating precisely:

- **Collection data** is offline-capable — Firestore, IndexedDB, working
- **Collection routes** are not — Next RSC payloads, service worker, not cached

Only the first was ever addressed. Shipping "works offline" with working data
and broken navigation is a half-delivered promise, and it sits squarely in what
the `feat/pwa` branch exists to do.

This is also the concrete case behind story 004's R2 finding. The reviewer
objected that the switching instrument mounts separate routes rather than
changing URLs. This is why that objection was correct: the defect lives in
navigation, and a test that mounts routes directly cannot see it.

Next step: determine what the service worker currently caches and whether RSC
payloads can be added to it.
