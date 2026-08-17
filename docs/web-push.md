# Web push

Push is the second channel. Everything in [Events](events.md) and [Identity](identity.md) works without
any of this.

## How it fits together

```
your page                 browser                   Arsel
──────────                ───────                   ─────
promptForPush()  ──────►  permission prompt
                          pushManager.subscribe()
                          ↳ endpoint + keys  ─────► POST …/push/subscriptions
                                                    ↳ deviceSecret (issued once)

                                        push   ◄──  send
/arsel-sw.js  ◄─── delivered ──────────────────
  showNotification()      ─── displayed ─────►  engagements
  user taps               ─── opened/clicked ►
```

## Setup

### 1. The service worker

Copy the worker from the package to your web root and point `init()` at it — registration is
opt-in, and without `serviceWorkerPath` the SDK registers nothing:

```bash
cp node_modules/@arsel/web-sdk/sw/arsel-sw.js public/arsel-sw.js
```

```js
await Arsel.init({ clientKey, baseUrl, serviceWorkerPath: '/arsel-sw.js' });
```

(The file is also exported as `@arsel/web-sdk/sw`. Self-hosting is the supported path today; a
hosted CDN URL you can `importScripts()` may come later.)

Root, because **service worker scope is a browser rule**: a worker served from `/js/` can only
control `/js/`. A file in the wrong place doesn't error — it just silently limits push to that
subtree, which you discover much later.

If your site is served from a subpath (`https://example.com/shop/`), the worker goes at
`/shop/arsel-sw.js` and you pass `serviceWorkerPath: '/shop/arsel-sw.js'`. Push then works for
`/shop/` and nothing above it.

**Already a PWA with a service worker on this scope?** Don't register a second one — two workers
cannot share a scope, and the SDK deliberately never overwrites yours. `importScripts('/arsel-sw.js')`
from inside your own worker instead, and initialize with `serviceWorker: 'external'`; the SDK then
uses the worker controlling the page.

### 2. VAPID keys

Generated per org in the dashboard. You never handle them: the SDK fetches the public key at
subscribe time and sends the subscription back. There is nothing to paste into your page.

The `applicationServerKey` a browser wants **is** the VAPID public key — same value, two names,
depending on whose spec you're reading.

### 3. Prompt from a gesture

```js
const subscribed = await Arsel.promptForPush();
```

Rules that are not ours to bend:

- **Never on page load.** Chrome's abusive-notification heuristics permanently block origins that do
  this, and you cannot undo it from your side.
- **Show your own primer first.** Explain what you'll send and why. Then call this only if they
  agree. A user who declines your primer can be asked again next month; a user who declines the
  browser's prompt cannot be asked again at all.
- **One real chance.** After *Block*, the browser will not prompt, `promptForPush()` returns `false`
  immediately, and only the user can reverse it in site settings.

`false` is a normal outcome, not an error: declined, unsupported browser, or the org's web channel
isn't switched on. The contact and its events exist either way.

## Browser support

| Browser | Push | Notes |
| --- | --- | --- |
| Chrome / Edge (desktop) | 42+ | |
| Firefox (desktop) | 44+ | |
| Safari (macOS) | 16.1+ | Ventura+ |
| Chrome / Firefox (Android) | yes | |
| **Safari (iOS/iPadOS)** | **16.4+, installed PWAs only** | The user must Add to Home Screen first. A site open in a Safari tab cannot subscribe. |
| Any browser in a private window | no | Subscriptions are refused or discarded on close |

`Arsel.diagnostics().permission` returns `'unsupported'` where the APIs are missing, rather than
throwing.

The iOS restriction is the one that costs teams a week. There is no workaround, and no error message
that says so — `promptForPush()` simply returns `false` in a normal iOS Safari tab.

## What the service worker does

| Browser event | Engagement | Notes |
| --- | --- | --- |
| `push` received | `delivered` | Fired **before** rendering. It means "the SDK got it", regardless of what the OS then does. |
| notification shown | `displayed` | |
| `showNotification()` threw | `suppressed` | Permission revoked between subscribe and delivery. Reported, so it lands in the org's numbers instead of vanishing. |
| body tapped | `opened` | |
| action button tapped | `clicked` | |
| notification dismissed | `dismissed` | Only for a real dismissal — the programmatic close that follows a tap does not also count as one. |

**Exactly one engagement per tap** — `opened` for the body, `clicked` for an action button, never both,
and never a trailing `dismissed`. Firing more than one would make the counters identical by
construction and none would mean anything.

The `delivered` engagement is raced against a short budget before rendering, so a slow network can
never hold the notification off the screen.

The worker reads its state from IndexedDB rather than being handed it by a page, because a
`delivered` engagement has to fire for a push that arrives when **no tab is open at all**.

### Clicks focus, they don't duplicate

A tap focuses an existing tab on your origin and navigates it to the deep link. Only if no tab exists
does it open a new window. Users end up with one tab, not one per notification.

### Action buttons

Chrome silently drops anything past **2** actions, so the SDK truncates to 2. Each action may carry
its own deep link; if it doesn't, the notification's link is used, and failing that, `/`.

## Rotation, and why you never see it

Two things rotate underneath a live subscription, and both make a user quietly unreachable — no
error, no bounce, just silence. Both are handled:

**VAPID rotation.** When your org rotates its keypair, every subscription created against the old
key is dead. `init()` compares the org's current key version with the one this browser subscribed
under and re-subscribes silently if it moved. No prompt — permission is already granted at that
point. The old subscription is unsubscribed first, because `subscribe()` with a different
`applicationServerKey` throws `InvalidStateError` while one is still live.

**Endpoint rotation.** Browsers rotate push endpoints on their own schedule and fire
`pushsubscriptionchange`. The service worker re-registers the new endpoint immediately; if it can't,
the next `init()` reconciles it.

## Testing it

1. `await Arsel.promptForPush()` → accept.
2. `console.table(await Arsel.diagnostics())` → `isSubscribed: true`, `hasDeviceSecret: true`.
3. Send a test push from the dashboard.
4. Watch the engagements: the campaign's delivered/displayed/opened counts move within seconds.

To test the "no tab open" path — the one that actually proves the worker is doing its job — close
every tab on your origin and send again. The notification should still arrive, and `delivered`
should still be counted.

<details>
<summary>Local development</summary>

`localhost` is exempt from the HTTPS requirement, so push works there over plain HTTP. It does not
work on a bare LAN IP (`http://192.168.1.5:3000`) — that's a secure-context failure, not an SDK one.

Chrome DevTools → Application → Service Workers is where you unregister a stale worker; a worker
updates on its own but a hard-stuck one is faster to remove than to reason about.
</details>

## Things that look like bugs

| Symptom | Actually |
| --- | --- |
| `promptForPush()` returns `false` with no error | Declined, unsupported, or the org's channel is off. All normal. |
| `promptForPush()` returns `false` **with** a console error | The worker setup is broken — `serviceWorkerPath` missing, registration failed, or the worker never activated. The message says which; it is checked *before* the prompt so a broken setup cannot burn it. |
| Nothing happens on iOS Safari | Push needs an installed PWA on iOS 16.4+. A tab cannot subscribe. |
| Registration fails with a MIME type error | Your SPA router is serving `index.html` for `/arsel-sw.js`. |
| Works on localhost, not on staging | Service workers need HTTPS. `localhost` is the only exemption. |
| `delivered` > `displayed` | Correct, and worth watching: the gap is suppressions — permission revoked after subscribing. |
| The prompt never appears again | The browser remembers *Block* forever. Only the user can undo it. |
| A user stopped receiving push with no error | Almost always endpoint or VAPID rotation — check `vapidKeyVersion` in diagnostics. |
