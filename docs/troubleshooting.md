# Troubleshooting

Start here, always:

```js
console.table(await Arsel.diagnostics());
```

It is safe to paste into a support ticket — no keys, no device secret, no endpoint.

---

## Events

### Nothing appears in the dashboard

Check `pendingEvents` and `lastResponseCode`.

| `lastResponseCode` | Meaning | Fix |
| --- | --- | --- |
| `202` | Delivered and accepted | Look under the *contact*, not the event list — a client-key event auto-creates its definition, so a brand-new name appears only after the first one lands |
| `403` | Origin not allowed | Add this exact origin in Settings → Push → Web. `https://www.x.com` ≠ `https://x.com` |
| `401` | Bad client key | You may be using a secret API key. The client key starts `pub_` |
| `429` | Rate limited | Retried automatically; nothing to do |
| `-1` | No response at all | Offline, DNS, TLS, or an ad blocker. Check the Network tab |
| `null` | Nothing was ever sent | `init()` never resolved — see below |

### `initialized: false`

`init()` threw. The two reasons are a missing `clientKey` and a non-HTTPS `baseUrl`; both throw from
the promise, so an un-awaited `init()` swallows them:

```js
await Arsel.init({ … });          // errors surface
void Arsel.init({ … });           // errors vanish
```

### `pendingEvents` only grows

Delivery is failing and events are being kept, which is the intended behaviour. Read
`lastResponseCode` in the table above. Once the cause clears, the whole backlog drains in order on
the next `track()` or page load.

### Events are missing after a redirect

The queue drains asynchronously. Before sending the user off-site (a payment provider, an OAuth
handoff), await it:

```js
await Arsel.flushNow();
window.location.href = checkoutUrl;
```

### An event name I sent doesn't exist in the dashboard

Names are **case-sensitive** and get truncated at 80 characters. `Product.Viewed` and
`product.viewed` are two different events.

### A `track()` call did nothing at all

Names starting `arsel.` are reserved and ignored, as are blank names. Turn on `debug: true` and the
SDK says so in the console.

---

## Identity

### A user has two contacts

Something identified them by different identifiers at different times and neither could absorb the
other. Typically: an email import created contact A, then the SDK identified with `externalId` only,
creating B.

The durable fix is to always assert the same `externalId`, and to include it in your imports so
existing contacts adopt it. See [Identity](identity.md#what-happens-on-a-merge).

Merges are not reversible, which is why the backend refuses ambiguous ones rather than guessing.

### Events attach to the wrong person on a shared computer

`reset()` isn't being called on logout, or the app uses `installationId` as a user id. The
installation id names the browser profile and survives logout on purpose; the anonymous id names the
person and is rotated by `reset()`.

### `identify()` seems to do nothing

It needs at least one of `externalId`, `email`, `phoneNumber` — a call with an empty object is
ignored. Under `debug: true` it logs the reason.

---

## Push

### `promptForPush()` returns `false` immediately

In order of likelihood:

0. **Push isn't configured, or the worker is broken.** These print a `console.error` saying exactly
   why: `serviceWorkerPath` was never passed to `init()`, the registration failed (404, wrong MIME
   type), or the worker never activated. Checked *before* the prompt, so a broken setup cannot burn
   the origin's one real chance.
1. **The user already blocked notifications.** `diagnostics().permission === 'denied'`. The browser
   will not prompt again; only the user can reverse it in site settings.
2. **iOS Safari, not installed.** iOS 16.4+ supports push only for PWAs added to the Home Screen.
   A site open in a Safari tab cannot subscribe, and there is no error saying so.
3. **Not a secure context.** HTTPS, or `localhost`. A LAN IP fails.
4. **The org's web channel isn't configured** — no VAPID keys yet.
5. **Private/incognito window.** Subscriptions are refused or discarded.

### The service worker won't register

First: is `serviceWorkerPath` actually passed to `init()`? Registration is opt-in — without it the
SDK registers nothing and only the events API runs. Then:

```bash
curl -I https://yoursite.com/arsel-sw.js
```

- **404** — the file isn't deployed. Copy `node_modules/@arsel.sa/web-sdk/sw/arsel-sw.js` into your
  framework's static-assets directory.
- **200 but `Content-Type: text/html`** — your SPA router is serving `index.html`. Exclude the path.
- **A MIME type error in the console** — same cause as above.

### Subscribed, but notifications don't arrive

| Check | |
| --- | --- |
| `isSubscribed: true` but `hasDeviceSecret: false` | The browser subscribed but the registration never reached Arsel. Look at `lastResponseCode` |
| Both true, still nothing | Check the campaign's own delivery numbers in the dashboard |
| It worked yesterday, not today | Endpoint or VAPID rotation. `init()` reconciles on the next page load; compare `vapidKeyVersion` with the org's current version |
| macOS | System Settings → Notifications → the browser must be allowed, and Focus/Do Not Disturb off |
| Windows | Focus Assist suppresses banners silently |

### `delivered` is higher than `displayed`

Correct, and worth watching. The gap is **suppressions**: the browser refused to show a notification
it had already received, almost always because permission was revoked between subscribing and
delivery. They're reported so they land in your numbers instead of vanishing.

### Opens and clicks are equal

They shouldn't be — `opened` is a body tap and `clicked` is an action button, exactly one per tap. If
they track each other exactly, something in your stack is double-reporting.

### A notification opened a second tab

The worker focuses an existing tab on your origin and navigates it. A second tab means no tab was
open on that origin, or the existing one was on a different origin.

---

## Build and integration

### `Arsel.default.init is not a function`

You're on an old UMD build. The current one exposes named exports at the top level:
`Arsel.init(...)`.

### `ReferenceError: indexedDB is not defined`

The SDK is being imported *and initialized* on the server (SSR). Importing is fine; guard the call:

```js
if (typeof window !== 'undefined') void Arsel.init({ … });
```

### The SDK is blocked by CSP

Add your API base to `connect-src`:

```
connect-src 'self' https://api.arsel.sa;
worker-src 'self';
```

### An ad blocker is eating the requests

Some block lists match on words like `events` and `track` in a path. `lastResponseCode: -1` with a
healthy network is the signature. Nothing the SDK can do about it; a first-party proxy path is the
usual answer.

---

## Getting help

Include in the ticket:

1. `await Arsel.diagnostics()` output
2. Browser and version, and whether it's a PWA on iOS
3. The failing call and its arguments
4. A Network tab entry for the failing request, with the status code
