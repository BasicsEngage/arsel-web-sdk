# API reference

Every public method. The default export and the named exports are the same functions:

```js
import Arsel from '@arsel/web-sdk';           // Arsel.track(…)
import { track, identify } from '@arsel/web-sdk';
```

Under a script tag, the same surface is on `window.Arsel`.

Every method except `init()` awaits initialization internally, so calling anything while `init()`
is still resolving is safe — it queues behind it. `track()` goes further: calls made before
`init()` is invoked at all are buffered in memory (up to 100) and moved into the durable queue,
in order and with their original timestamps, when `init()` supplies the configuration.

---

## `init(config)`

```ts
init(config: ArselConfig): Promise<void>
```

Starts the SDK: stores the config, mints the anonymous id, drains the pre-init `track()` buffer,
registers the service worker (only when `serviceWorkerPath` is configured — never by default),
attaches session listeners, opens a session if the page is actually visible (a background tab or a
prerendered page opens its session on the visibility transition instead), flushes anything stranded
by a previous page, and reconciles the push subscription if the org rotated its VAPID keys.

**Idempotent.** A second call returns the first one's promise, so a framework that mounts twice does
not mint two identities.

**Never prompts for notification permission.** Use [`promptForPush()`](#promptforpush).

### `ArselConfig`

| Field | Type | Required | |
| --- | --- | --- | --- |
| `clientKey` | `string` | yes | The org's publishable `pub_…` key. Page-readable by design. |
| `baseUrl` | `string` | yes | Arsel API base. **HTTPS enforced** — `http://localhost` / `http://127.0.0.1` are the one exception, for a local backend. Trailing slashes are trimmed. |
| `serviceWorkerPath` | `string` | for push | Path to the self-hosted `arsel-sw.js`. **No default** — without it the SDK registers no worker and only the events API runs. Scope is bound to this path's directory. |
| `serviceWorker` | `'external'` | no | Your own service worker `importScripts` arsel-sw.js; the SDK registers nothing and uses the worker controlling the page. |
| `debug` | `boolean` | no | Log SDK decisions to the console. Default `false`. |

### Throws

| | |
| --- | --- |
| `Arsel: clientKey is required` | empty or missing key |
| `Arsel: baseUrl must be HTTPS (http is allowed for localhost only)` | non-HTTPS base URL that isn't localhost |

Both are thrown from the returned promise. Nothing else in the SDK throws at the caller.

```js
await Arsel.init({
  clientKey: 'pub_…',
  baseUrl: 'https://api.arsel.sa',
  serviceWorkerPath: '/arsel-sw.js',
  debug: false,
});
```

---

## `track(name, properties?)`

```ts
track(name: string, properties?: EventProperties): Promise<void>
```

Records something the user did. Resolves once the event is **persisted**, not delivered. Never
rejects.

| Argument | | |
| --- | --- | --- |
| `name` | `string` | Trimmed. Max 80 chars (truncated). Blank names and names starting `arsel.` are ignored. |
| `properties` | `Record<string, unknown>` | Optional. JSON-safe values — strings, finite numbers, booleans, `null`, and nested arrays/objects — are sent as-is. `Date` becomes an ISO string; functions, symbols and `undefined` are dropped; `NaN`/`Infinity` are stringified. Serialized `data` is capped at 64 KB. |

Works with no permission, no subscription and nobody logged in. See [Events](events.md).

```js
Arsel.track('order.placed', { order_id: 'A-1023', total: 149.99, currency: 'SAR' });
```

---

## `identify(identity)`

```ts
identify(identity: ArselIdentity): Promise<void>
```

Binds this browser to a person. Everything tracked beforehand under the anonymous identity merges
onto the contact this resolves to. Identifiers are remembered and ride every later event — call it
once per login, not per event.

| Field | Type | |
| --- | --- | --- |
| `externalId` | `string` | **Preferred.** Your own id for this person. Max 255 chars. |
| `email` | `string` | Must look like an email address. |
| `phoneNumber` | `string` | **E.164 enforced**, e.g. `+966501234567`. |

Invalid values are rejected with a `console.error` and **not stored** — one malformed phone number
would otherwise ride every subsequent event and get each one rejected. At least one valid
identifier is required; a call with none is ignored (logged under `debug`). Emits `arsel.identify`
immediately rather than waiting for your next `track()` — the merge is what you asked for, and
deferring it leaves the two contacts split until something unrelated happens to fire.

See [Identity](identity.md) for merge and conflict rules.

```js
Arsel.identify({ externalId: user.id });
```

---

## `reset()`

```ts
reset(): Promise<void>
```

Logout. Forgets `externalId`, `email`, `phoneNumber` and the current session, and **rotates the
anonymous id** so the next person on this browser doesn't inherit the previous one's history.

**Does not unsubscribe from push** — deliberately. The backend's opt-out is durable and
non-resurrectable, so calling it on logout would permanently kill push on a shared machine.
"Stop sending me notifications" is a different intent — that one is [`optOut()`](#optout).

---

## `optOut()`

```ts
optOut(): Promise<boolean>
```

Durable push opt-out for this browser — the user asked to stop receiving notifications. The
revocation is **server-side and non-resurrectable**: a later registration of the same installation
does not undo it, and re-opt-in is an explicit, separate act on the backend. Wire it to your
notification-preferences UI, never to logout (that's [`reset()`](#reset)).

Returns `false` when this browser never completed a push registration — there is nothing to
revoke — or the request failed.

---

## `promptForPush()`

```ts
promptForPush(): Promise<boolean>
```

Requests notification permission and subscribes. **Call from a click**, never on page load.

Returns `true` only if permission was granted *and* the subscription registered with Arsel.
`false` means: the user declined, the browser doesn't support push, or the org's web channel isn't
configured. None of those are errors.

The service worker is verified **before** the prompt: a missing `serviceWorkerPath`, a failed
registration, or a worker that never activates fails fast with a `console.error` saying why,
instead of burning the origin's one real permission prompt on a subscription that can never settle.

```js
button.addEventListener('click', async () => {
  if (await Arsel.promptForPush()) showThanks();
});
```

---

## `getAnonymousId()`

```ts
getAnonymousId(): Promise<string>
```

The identity events carry before login. Rotated by `reset()`. Useful for correlating a browser
session with your own server-side logs.

Not a user identifier — see [Identity](identity.md#the-two-ids-and-why-they-are-not-one-id).

---

## `flushNow()`

```ts
flushNow(): Promise<void>
```

Delivers everything queued now, instead of on the next natural drain. Resolves when the queue is
empty or hits a retryable failure. Useful before redirecting to an external payment page, and in
tests. Not needed in normal operation.

Serialised: calling it while a drain is in flight returns that drain's promise rather than starting a
second one.

---

## `diagnostics()`

```ts
diagnostics(): Promise<ArselDiagnostics>
```

A snapshot safe to paste into a support ticket. Contains **no** client key, no device secret and no
push endpoint.

| Field | Type | Means |
| --- | --- | --- |
| `sdkVersion` | `string` | |
| `initialized` | `boolean` | `init()` has been called |
| `anonymousId` | `string \| null` | Must change after `reset()` |
| `hasAssertedIdentity` | `boolean` | `identify()` supplied at least one identifier |
| `installationId` | `string \| null` | Names this browser profile, not the person |
| `hasDeviceSecret` | `boolean` | Registration completed. `false` with `isSubscribed: true` means the subscription never reached Arsel |
| `pendingEvents` | `number` | Persisted, undelivered. Only-growing is the tell |
| `permission` | `'granted' \| 'denied' \| 'default' \| 'unsupported'` | The browser's own state |
| `isSubscribed` | `boolean` | A live push subscription exists |
| `vapidKeyVersion` | `number \| null` | Which key version this browser subscribed under |
| `lastResponseCode` | `number \| null` | Last HTTP status. `-1` = no response at all (offline, DNS, TLS) |
| `lastResponsePath` | `string \| null` | Which call it was |
| `lastResponseAtMs` | `number \| null` | Epoch ms |

---

## `SDK_VERSION`

```ts
const SDK_VERSION: string
```

---

## Types

```ts
interface ArselConfig {
  clientKey: string;
  baseUrl: string;
  serviceWorkerPath?: string;
  serviceWorker?: 'external';
  debug?: boolean;
}

interface ArselIdentity {
  externalId?: string;
  email?: string;
  phoneNumber?: string;
}

type EventProperties = Record<string, unknown>;
```

All are exported from the package root.

---

## Network calls

For your CSP and your security review. The SDK talks to your configured `baseUrl` and nowhere else —
no third-party hosts, no CDNs at runtime, no cookies (`credentials: 'omit'` on every request).
Every request carries an `X-Arsel-SDK: web/<version>` header.

| Call | From | Auth |
| --- | --- | --- |
| `POST /v1/events/send` | page | `Authorization: Bearer <clientKey>` |
| `GET /api/v1/orgs/{clientKey}/push/web/config` | page | none (public config) |
| `POST /api/v1/orgs/{clientKey}/push/subscriptions` | page + service worker | none (registration mints the secret) |
| `POST /api/v1/orgs/{clientKey}/push/subscriptions/unsubscribe` | page | `X-Arsel-Device-Auth: <deviceSecret>` |
| `POST /api/v1/orgs/{clientKey}/push/engagements` | service worker | `X-Arsel-Device-Auth: <deviceSecret>` |

Event delivery batches up to 50 queued events per request (`{ "events": [...] }`; a single event is
sent as a bare object) and stamps each request with an `Idempotency-Key` derived from the persisted
per-event keys, so a retried request that actually landed dedupes inside the backend's 24-hour
window instead of double-counting.

CSP: `connect-src https://api.arsel.sa;` (or your base URL). Push notification images are fetched by
the browser itself and are not subject to your page's CSP.

---

## Cross-SDK parity

The same platform surface, per channel. Per-platform prompt names are deliberate — each one describes
what actually happens on that platform.

| Capability | Android | Web |
| --- | --- | --- |
| Start | `initialize(...)` | `init(config)` |
| Identify | `identify(...)` | `identify(identity)` |
| Server-vouched identify | `identifyWithToken(...)` | — (use `identify()`, or bind server-side) |
| Track | `track(name, properties)` | `track(name, properties)` |
| Logout | `reset()` | `reset()` |
| Durable push opt-out | `optOut()` | `optOut()` |
| Ask for push | `requestNotificationPermission()` | `promptForPush()` |
| Force delivery | `flushNow()` | `flushNow()` |
| Support snapshot | `diagnostics()` | `diagnostics()` |
