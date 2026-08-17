# Changelog

All notable changes to `@arsel/web-sdk`. Format follows [Keep a Changelog](https://keepachangelog.com/),
versioning follows [Semantic Versioning](https://semver.org/).

Breaking changes to the public surface wait for a major release, and are listed here explicitly.

## [Unreleased]

## [1.0.0] — 2026-08-17

### Added

- **Events channel.** `track(name, properties)` with a durable IndexedDB queue: events are persisted
  before they are sent, drain oldest-first in batches of up to 50 per request, stop at the first
  retryable failure so history is never reordered, and discard permanent failures rather than
  wedging the queue behind them — logging the response body when a drop carried identifiers.
  Retries dedupe via persisted per-event idempotency keys and an `Idempotency-Key` request header.
  Drains also trigger on `online` and on the tab becoming visible. Event properties pass through as
  arbitrary nested JSON (`Date` → ISO string, non-JSON values dropped, 64 KB cap). `track()` calls
  made before `init()` are buffered (up to 100) and enqueued, in order, when `init()` runs.
- **Identity.** `identify({ externalId, email, phoneNumber })` and `reset()`. `reset()` rotates the
  anonymous id so a shared computer does not hand the next person the previous one's history.
  `phoneNumber` is validated as E.164 and `email` for shape at the door — invalid values are
  rejected with a console error instead of stored, so one bad identifier cannot poison every
  subsequent event.
- **`optOut()`** — durable, server-side, non-resurrectable push opt-out for this browser, distinct
  from `reset()`, which never touches push.
- **Sessions.** `arsel.session_start` / `arsel.session_end` from visibility transitions, with the
  industry-standard 30-minute background gap and no timers. The end event is emitted on the next
  visit, backdated to when the page actually went away. Sessions only open for pages actually seen —
  background tabs and prerendered pages wait for their first visible transition.
- **Web push.** `promptForPush()`, opt-in service-worker registration (`serviceWorkerPath`, or
  `serviceWorker: 'external'` for PWAs whose own worker imports arsel-sw.js — the SDK never
  clobbers an existing worker), subscription registration carrying the `anonymousId` that binds the
  subscription to the contact, and engagements (`delivered`, `displayed`, `suppressed`,
  `opened`, `clicked`, `dismissed`) — exactly one per tap, with the post-tap programmatic close
  never double-reported as a dismissal, and the `delivered` engagement raced against a short budget so
  it can never delay display. Worker readiness is verified with bounded, actionable failures before
  the permission prompt, never via a `.ready` that can hang forever.
- **Silent VAPID reconciliation** on `init()`: a browser subscribed under a rotated keypair
  re-subscribes without prompting, instead of going quietly unreachable.
- **`pushsubscriptionchange` handling** in the service worker, for browser-initiated endpoint
  rotation.
- `diagnostics()` — a support-ticket-safe snapshot containing no keys and no device secret.
- `flushNow()`, `getAnonymousId()`, `debug` mode.
- Every request carries `X-Arsel-SDK: web/<version>`.
- `baseUrl` may be plain `http://` for `localhost`/`127.0.0.1`, for local backends.
- ESM + UMD builds. The UMD build exposes named exports on `window.Arsel`.

### Notes

- The events API never depends on push. `track()` and `identify()` work with notifications denied,
  blocked, or never requested.
- The publishable `pub_…` client key is page-readable by design. Origin allowlisting bounds the
  residual risk. A secret API key must never appear in page source.
