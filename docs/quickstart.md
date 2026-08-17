# Quickstart

From nothing to a verified event and a verified push in about ten minutes.

## Before you start

You need two things from the Arsel dashboard:

| | Where | Looks like |
| --- | --- | --- |
| Client key | Settings → Push → Web | `pub_…` |
| API base URL | Fixed per environment | `https://api.arsel.sa` |

Your site's origin must be on the org's allowlist (Settings → Push → Web → Allowed origins). Requests
from an origin that isn't listed are rejected with `403`; that check is what stands between a
page-readable key and someone else farming your org's events.

Add every origin you actually serve from, including `http://localhost:3000` for development. Origins
are matched exactly — `https://shop.example.com` does not cover `https://www.shop.example.com`.

## 1. Install

```bash
npm install @arsel/web-sdk
```

<details>
<summary>No bundler? Use the UMD build.</summary>

unpkg and jsDelivr serve it from npm — pin the version and add an SRI hash, or copy
`node_modules/@arsel/web-sdk/dist/arsel.umd.cjs` into your own static assets and serve it yourself:

```html
<script src="/js/arsel.umd.cjs"></script>
<script>
  Arsel.init({ clientKey: 'pub_…', baseUrl: 'https://api.arsel.sa' });
</script>
```

Everything below is identical; `Arsel` is a global instead of an import.
</details>

## 2. Initialize

Once, as early as you can. `track()` calls made before `init()` are buffered in memory (up to 100)
and written to the durable queue the moment `init()` supplies the configuration — but the buffer is
page-lifetime only, so the earlier you initialize, the less you have at risk.

```js
import Arsel from '@arsel/web-sdk';

await Arsel.init({
  clientKey: 'pub_…',
  baseUrl: 'https://api.arsel.sa',
  serviceWorkerPath: '/arsel-sw.js',   // omit if you only want events
});
```

`init()` is idempotent: a second call returns the first one's promise, so a framework that mounts
twice does not mint two identities.

It **never** requests notification permission. See [step 4](#4-ask-for-push-from-a-click).

<details>
<summary>Single-page apps and frameworks</summary>

Call it once at module scope or in your root component's mount, not per route. In Next.js or any SSR
framework, guard for the server:

```js
if (typeof window !== 'undefined') {
  void Arsel.init({ clientKey, baseUrl });
}
```

The SDK touches `indexedDB`, `navigator` and `document` at init, so importing it on the server is
fine but calling `init()` there is not.
</details>

## 3. Add the service worker

**Required for push. Skip it if you only want events — without `serviceWorkerPath` the SDK
registers no worker at all.**

Copy the worker from the package to your web **root** as `/arsel-sw.js`:

```bash
cp node_modules/@arsel/web-sdk/sw/arsel-sw.js public/arsel-sw.js
```

(The file is also exported as `@arsel/web-sdk/sw` for build tooling. A hosted CDN URL you can
`importScripts()` instead may come later; self-hosting is the supported path today.)

It has to be at the root. Service worker scope is a browser rule, not ours: a worker served from
`/js/` can only control `/js/`, so a file anywhere else silently limits push to that subtree.

| Framework | Put the file in |
| --- | --- |
| Vite | `public/arsel-sw.js` |
| Next.js | `public/arsel-sw.js` |
| Create React App | `public/arsel-sw.js` |
| Angular | `src/arsel-sw.js` + an entry in `angular.json` `assets` |
| Plain static site | the document root |

Then pass its path to `init()` — registration is opt-in, so the SDK never overwrites a service
worker you already have:

```js
await Arsel.init({ clientKey, baseUrl, serviceWorkerPath: '/arsel-sw.js' });
```

<details>
<summary>Already a PWA with your own service worker?</summary>

Two workers cannot share a scope, so don't register a second one. Merge Arsel into yours instead:

```js
// inside your existing service worker
importScripts('/arsel-sw.js');   // the file you copied above
```

and tell the SDK to use the worker you registered:

```js
await Arsel.init({ clientKey, baseUrl, serviceWorker: 'external' });
```
</details>

Verify it is served correctly — this is the single most common setup mistake:

```bash
curl -I https://yoursite.com/arsel-sw.js
# 200, and Content-Type: text/javascript or application/javascript
```

A `200` returning your SPA's `index.html` means your router swallowed the path. The registration will
then fail with a MIME type error in the console.

If you must serve it from elsewhere, point `serviceWorkerPath` there and accept the narrower scope:

```js
await Arsel.init({ clientKey, baseUrl, serviceWorkerPath: '/static/arsel-sw.js' });
```

## 4. Ask for push, from a click

```html
<button id="enable">Enable notifications</button>
```

```js
document.querySelector('#enable').addEventListener('click', async () => {
  const subscribed = await Arsel.promptForPush();
  if (!subscribed) {
    // Normal outcome: declined, unsupported, or the org's web channel is off.
  }
});
```

**Never call this on page load.** A permission prompt fired without a user gesture is what gets an
origin permanently blocked by Chrome's abusive-notification heuristics, and that block is not
something you can undo from your side. Show your own primer first — explain what you'll send — and
only call `promptForPush()` when they say yes to *that*.

You get one real chance per browser: once a user picks *Block*, the browser will not prompt again,
and only they can reverse it in site settings.

## 5. Track and identify

```js
Arsel.track('product.viewed', { sku: 'A-1023', price: 149.99 });

// On login, once — not per event.
Arsel.identify({ externalId: user.id });

// On logout.
Arsel.reset();
```

Events tracked before `identify()` attach to the anonymous identity and are merged onto the contact
when you identify. That is the whole point of the anonymous id — see [Identity](identity.md).

## 6. Verify

```js
console.table(await Arsel.diagnostics());
```

What you want to see:

| Field | Healthy |
| --- | --- |
| `initialized` | `true` |
| `anonymousId` | a UUID |
| `pendingEvents` | `0`, or briefly non-zero then back to `0` |
| `lastResponseCode` | `202` after a `track()`, `200` after a subscribe |
| `permission` | `granted` once the user accepted |
| `isSubscribed` | `true` once the user accepted |

Then check the dashboard: the contact appears under **Audience**, and the event under **Events**.
A client-key event whose name isn't defined yet **defines itself** on first receipt, so you do not
have to create the event in the dashboard before sending it from the browser.

If something is off, go to [Troubleshooting](troubleshooting.md).

## Checklist

- [ ] `init()` called once, with an HTTPS `baseUrl`
- [ ] your origin is on the org allowlist (including localhost for dev)
- [ ] `/arsel-sw.js` returns 200 with a JavaScript content type, and `serviceWorkerPath` points at it
- [ ] `promptForPush()` is behind a click, after your own primer
- [ ] `identify()` on login, `reset()` on logout
- [ ] a real event and a real contact visible in the dashboard
