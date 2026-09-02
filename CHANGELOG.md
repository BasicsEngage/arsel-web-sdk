# Changelog

All notable changes to `@arsel.sa/web-sdk`. Format follows [Keep a Changelog](https://keepachangelog.com/),
versioning follows [Semantic Versioning](https://semver.org/).

Breaking changes to the public surface wait for a major release, and are listed here explicitly.

## [1.2.0] — 2026-09-02

### Changed

- **`screen()` now emits `arsel.screen_view`, not `arsel.screen`.** The Android and
  iOS SDKs have always used `screen_view`, and the split meant a segment or in-app
  rule keyed on one name silently never matched the other platform. Renamed here
  rather than on mobile because two of the three SDKs already agreed, and because
  `screen()` only shipped in 1.1.0 — the exposure is ten days wide. If you built a
  segment or automation on `arsel.screen`, repoint it at `arsel.screen_view`.

### Added

- **`arsel.app_installed`.** Emitted once per browser profile, on the first `init()` the SDK ever
  runs there, ahead of the first `arsel.session_start`. Carries `sdk_version` and `platform`. A
  browser has no install step, so this means "the first time we saw this device" — clearing site
  data or opening a private window resets the store and re-fires it, and web install counts run
  high by exactly that much.

  **Browsers that already used an older version get no install event.** They are seeded silently on
  their first load after the upgrade: emitting would have reported the whole existing audience as
  installs on the day you shipped. Install-based segments start empty and fill forward.

## [1.1.0] — 2026-08-23

### Added

- **In-app messaging.** Messages authored in Arsel now render in the page, with no notification
  permission and no prompt of any kind. The server resolves audience, consent, campaign window,
  grants and lifetime caps into a per-device bundle; the SDK evaluates the trigger and the
  session-scoped caps locally, so drawing a message costs no network round-trip. Four layouts —
  `MODAL`, `BANNER_TOP`, `BANNER_BOTTOM`, `IMAGE_ONLY` — rendered into a closed shadow root with
  a constructed stylesheet (falling back to `<style>`), text set with `textContent` only, and
  colours applied through CSSOM so a strict `style-src` cannot strip them.
- **`screen(name, properties?)`.** Records a screen or page view. One request, two consumers: the
  event reaches segments and automations exactly as `track()` would, and it is the trigger source
  for `SCREEN_VIEW` in-app messages.
- **`suppressInAppMessages(boolean)`.** Holds messages back for the moments a host app knows are
  wrong — a checkout step, a video playing full-screen.
- **`inApp` config option.** `true` by default; pass `false` to disable, or `{ zIndex, closeLabel }`
  to tune the layer. The default `zIndex` sits below the maximum so a host site's own top-most
  modal still wins.
- **Device registration without a push subscription.** `init()` now registers the browser so the
  bundle fetch can authenticate. It shows no prompt, creates no subscription, and never touches the
  service worker — gating in-app behind `promptForPush()` would have restricted the channel to the
  minority who accept notifications.
- **Accessibility.** Modals get `role="dialog"`, `aria-modal`, a focus trap reading `root.activeElement`
  (a closed root makes `document.activeElement` resolve to the host), focus capture and restore, and
  `Escape` to dismiss. Banners get `role="status"` with `aria-live="polite"` and never steal focus.
  Direction is read from the host page, not assumed.
- **`arsel_iam_sync` service-worker handling.** A reserved silent push refreshes the bundle and
  renders nothing. Ships inert — nothing emits it yet — so refresh is driven by `init()`, tab
  visibility and the bundle's own TTL.
- Diagnostics gain `inAppMessages`, `inAppBundleVersion`, `inAppFetchedAtMs` and
  `pendingInAppBeacons`.
- **`diagnostics().configError`.** Reports why initialization was refused, readable before
  initialization — which is precisely the state it describes.

### Changed

- **`getJson()` returns the full `{ result, code, body }` envelope**, matching `post()`. The bundle
  fetch has to branch on `304` *before* `classify()` sees it — `classify` maps 304 to `permanent`,
  which would discard the cache on every successful revalidation.
- **The store's queue helpers take a leading queue name.** In-app beacons live in their own object
  store: the events drain stops at the first retryable failure to preserve history order, so a
  single stuck beacon sharing that queue would wedge the entire analytics pipeline behind it.
- IndexedDB schema version 1 → 2, adding the beacon store. The upgrade is guarded by store name, so
  a browser installed at v1 gains only what it is missing.
- The service worker now closes its database handle after reading. It opens without a version, and
  a connection left open makes the page's upgrade fire `blocked` and hang until the worker is
  terminated.
- **`init()` no longer rejects on invalid configuration.** It is routinely called un-awaited, so the
  rejection reached the page as an unhandled rejection the host could not catch — and an analytics
  SDK must not break a page over its own misconfiguration. It logs, declines to start, and the
  collecting calls then genuinely no-op: a refused SDK that still queued would grow IndexedDB
  behind a flush that can never succeed. All three Arsel SDKs now behave identically here.
- The four configuration rules match the Android and iOS SDKs exactly, including the `pub_` prefix
  check — the one that catches a secret API key pasted into page-readable source.

### Fixed

- **An unreachable push service no longer escapes `init()`.** `pushManager.subscribe()` rejects
  whenever the browser cannot reach its push service — a firewalled network, a captive portal,
  private browsing, a Chromium build without push support. None are the caller's mistake and none
  are feature-detectable. Both call sites now resolve to `null` like every other failure here.
- **`init()` no longer leaks an unhandled rejection from its background work.** It kicks off the
  stranded-events flush and the push reconcile fire-and-forget, and neither carried a catch — so
  anything they threw (a queue row that will not parse, an IndexedDB failure) surfaced on the host
  page as a rejection it could not intercept. The same failure mode `init()` itself was hardened
  against in this release, through a different door. Both now match the catch every other
  fire-and-forget call site here already used.
- **A revoked device no longer reports as subscribed.** A durable opt-out answers the register call
  with `200` and deliberately leaves the row `REVOKED`; reading only the HTTP status, `subscribe()`
  returned `true`, and `isSubscribed()` asked the browser, which keeps its `PushSubscription`
  across an opt-out. So `promptForPush()` reported success and an app would show "notifications on"
  to someone who can never receive another push. The backend's status is now persisted and
  consulted as `subscriptionStatus`, matching the Android SDK.

### Requires

- Backend support for the in-app endpoints, CORS on `/api/v1/orgs/*/in-app/*`, `If-None-Match` in
  the client-API allowed headers, and the org's `allowedOrigins` containing the customer's origin —
  an empty allowlist matches nothing and rejects every visitor.

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
