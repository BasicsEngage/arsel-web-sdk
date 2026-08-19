# In-App Messaging — Web SDK Contract

**Status:** shipped in SDK 1.1.0 (2026-08-19). Backend shipped 2026-08-17.
**Canonical spec:** `IN-APP-MESSAGING-WIRE-CONTRACT.md` at the platform root. This file is the web-specific reading of it.

---

## 1. What this is, and why it is not web push

Web push is delivered by the browser's push service whether or not your site is open, and requires notification permission. An in-app message is **drawn in the page, by this SDK, while the visitor is on the site**. No service worker, no push service, and — importantly — **no permission prompt of any kind**.

That last point makes web the highest-reach surface of the three: every visitor is addressable, including the large majority who declined notifications.

1. The SDK fetches a **bundle** — every message this browser may show — on init and on visibility change, and caches it.
2. The visitor does something; the SDK matches it against each message's **trigger**.
3. The SDK applies the **frequency caps** locally and draws the winner.
4. The SDK reports **impression / click / dismiss** beacons.

Audience, consent, campaign window, grant expiry and lifetime caps are resolved server-side before a message enters the bundle. The browser decides *when*, never *who qualifies*.

All three trigger types work: `APP_OPEN` fires on a session opening, `SCREEN_VIEW` on `screen()`, and `CUSTOM_EVENT` on `track()`.

---

## 2. Endpoints

### 2.1 Bundle

```
GET {baseUrl}/api/v1/orgs/{clientKey}/in-app/bundle?installationId={id}
Headers:
  X-Arsel-Device-Auth: <deviceSecret>    // required
  X-Arsel-SDK: web/<version>             // required — gates capability
  If-None-Match: "<bundleVersion>"       // optional
```

Response as in the canonical spec: `contractVersion`, `bundleVersion`, `ttlSeconds`, and `messages[]` each carrying `campaignId`, `messageId`, `priority`, `expiresAt`, `trigger`, `displayRules`, `layout`, `content` and `buttons`.

**Requires a registration.** `installationId` and `deviceSecret` are minted by `POST …/push/subscriptions`, which `init()` now calls on its own — no prompt, no subscription. See §4.

Refetch on `init()`, on `visibilitychange → visible` (respecting `ttlSeconds`), and on a service-worker `arsel_iam_sync` message. Never poll.

### 2.2 Beacons

```
POST {baseUrl}/api/v1/orgs/{clientKey}/in-app/events
Headers: X-Arsel-Device-Auth, X-Arsel-SDK
{
  "installationId": "…",
  "events": [                              // max 50
    {
      "messageId": "…",                    // required
      "campaignId": "…",                   // required
      "eventType": "impression" | "clicked" | "dismissed" | "expired",
      "timestamp": "2026-08-17T10:03:22.581Z",
      "buttonId": "cta_primary",           // clicked only
      "triggerEventName": "cart.viewed",
      "visibleSeconds": 4                  // dismissed only
    }
  ]
}
→ 202 { "accepted": n, "duplicates": n, "rejected": n }
```

Route through the existing durable queue in `transport.ts` / `store.ts`, and flush on `visibilitychange → hidden` as the event pipeline already does. A tab closed on an unflushed impression is the common loss case on web.

**No `sent`, `delivered` or `failed`.** Nothing was sent; `impression` is the denominator for every rate.

### 2.3 Sync ping

A web push may arrive carrying data key **`arsel_iam_sync` = `"1"`**, with no title and no body.

`sw/arsel-sw.js` must **not** call `showNotification()` for it — post a message to any open client instead, and let the page refetch its bundle. A browser without notification permission never receives the ping at all and simply refetches on next visibility; eligibility must never depend on it.

⚠️ A push event that shows no notification can cost a service worker its push permission in some browsers, which enforce a "must display" rule. Prefer letting the bundle TTL and visibility refetch carry the load on web, and treat the ping as a best-effort optimisation only.

---

## 3. Capability gating

The bundle endpoint reads `X-Arsel-SDK` and returns an **empty bundle** below the IAM-capable minimum, currently `web/1.1.0` (`IN_APP_MIN_SDK_VERSION` in the backend).

`SDK_VERSION` is `1.1.0`, so this build receives real bundles. Anything older gets an empty one — a bundle handed to a build that cannot draw it fails invisibly, which is what the gate prevents.

`IN_APP_SUPPORTED_LAYOUTS.web` deliberately omits `FULLSCREEN`: a full-viewport takeover on the open web reads as an interstitial and is penalised by Google's intrusive-interstitial rules on mobile. Add it only as a deliberate product decision.

---

## 4. Device registration

`init()` registers the browser through `POST …/push/subscriptions` with **no `endpoint` and no `keys`** — an in-app-only registration. It shows no permission prompt, creates no push subscription, and never touches the service worker.

That shape is deliberate. In-app messaging needs no notification permission, so gating it behind `promptForPush()` would restrict the channel to the minority who accept notifications and throw away most of its reach. The backend accepts a credential-less web registration for exactly this reason, and treats such a row as ACTIVE but not push-addressable — so it never inflates push reach or receives a notification.

Two behaviours are preserved and covered by tests:

- `init()` stays idempotent, and registration is single-flighted on top of it, so a `promptForPush()` racing init cannot post twice and mint a second `deviceSecret`.
- Nothing here prompts. The deliberate refusal to prompt on load is what keeps an origin out of Chrome's abusive-notification heuristics.

**The org's `allowedOrigins` must contain the customer's origin.** An empty allowlist matches nothing, so registration returns 403 for every visitor and in-app stays silently inert. The SDK logs that case distinctly from the opaque 404, because it is the one auth failure here that is a configuration problem rather than ordinary onboarding.

## 5. Renderer notes specific to web

- **Isolate the styles.** Render into a shadow root; a host site's global CSS will otherwise reshape the message, and the message's CSS must never leak into the host.
- **Layer deliberately.** Pick a `z-index` that clears typical site chrome without fighting the host's own modals, and expose it as config.
- **Accessibility is not optional.** `role="dialog"`, `aria-modal`, focus trapped while open, focus restored on close, `Escape` dismisses. A banner should not trap focus.
- **Respect the viewport.** Banners must not cover a fixed header or a cookie bar the site already shows; keep the message inside a scroll-safe container.
- Honour `prefers-reduced-motion` for entry and exit.
- **Do not double-report events.** The SDK already posts `track()` to `/v1/events/send`; the trigger engine observes those calls locally rather than re-sending them. Duplicating would double-count every event in segments and automations.

---

## 6. Display rules — evaluation order

When a trigger fires:

1. Drop anything past `expiresAt`.
2. Drop anything at `maxLifetime`.
3. Drop anything at `maxPerSession` this session (the existing `session.ts` defines the session).
4. Drop anything inside `minSecondsBetween`.
5. Take the **highest `priority`**; tie-break on earliest `expiresAt`, then server order.
6. **One at a time.** Never stack.
7. Honour `delaySeconds`; abandon if the visitor navigates away first.

A cap may be exceeded by one across a bundle-refresh boundary — accepted and specified, because a synchronous server check would put the network between the trigger and the message.

---

## 7. Shipped in 1.1.0

- Device registers on `init()` without a permission prompt, single-flighted
- Renders `MODAL`, `BANNER_TOP`, `BANNER_BOTTOM` and `IMAGE_ONLY`
- Closed shadow root, constructed stylesheet with a `<style>` fallback, `all: initial` first in `:host`
- Focus capture/restore and a trap reading `root.activeElement`; `Escape` dismisses; banners never steal focus
- `arsel_iam_sync` refreshes the bundle and shows no notification
- Beacons carry the exact `messageId`; repeat displays reuse it, so the server's `(messageId, eventType, subscriptionId)` dedupe collapses them by design
- `If-None-Match` sent with `cache: 'no-store'`; `304` handled before `classify()`

**Known limits.** `FULLSCREEN` is never rendered on web. The bundle is capped at 25 messages server-side, and both truncation and dropped layouts are only visible through `debug: true` logging. Frequency caps may be exceeded by one across a bundle-refresh boundary — specified behaviour, not a defect.
