# Arsel Web SDK

Events, identity and web push for the browser. ~4 kB gzipped, no dependencies, ESM + UMD.

```js
import Arsel from '@arsel.sa/web-sdk';

await Arsel.init({ clientKey: 'pub_…', baseUrl: 'https://api.arsel.sa' });

Arsel.track('product.viewed', { sku: 'A-1023', price: 149.99 });
Arsel.identify({ externalId: user.id });
```

**Two channels, and only one of them needs push.** `track()` and `identify()` work with notifications
denied, blocked, or never asked for — a visitor who declines still has a contact and a behavioural
history. Only delivery needs a subscription. Nothing in the events API waits on the push API.

---

## Documentation

| | |
| --- | --- |
| **[Quickstart](docs/quickstart.md)** | Install, initialize, and verify in about ten minutes. |
| **[Identity](docs/identity.md)** | Anonymous → identified, the identifier ladder, merges, `reset()`. |
| **[Events](docs/events.md)** | Custom events, properties, limits, reserved events, sessions, durability. |
| **[Web push](docs/web-push.md)** | Service worker, VAPID, permission UX, browser support, engagements. |
| **[API reference](docs/api-reference.md)** | Every method: signature, arguments, returns, when to call it. |
| **[Troubleshooting](docs/troubleshooting.md)** | Symptom → cause → fix, and the things that only look like bugs. |
| **[Data collection](docs/data-collection.md)** | What the SDK stores and sends, and what it never does. GDPR/erasure. |
| **[Migrating from CleverTap](docs/migrating-from-clevertap.md)** | API mapping, identity mapping, and the traps. |
| **[Changelog](CHANGELOG.md)** | Release notes. |

## Requirements

| | |
| --- | --- |
| Browsers | Chrome/Edge 79+, Firefox 72+, Safari 16.4+, and their mobile equivalents |
| Transport | Your **page** must be served over HTTPS for push (`http://localhost` is the browser's one exemption). The **API `baseUrl`** must be HTTPS too, except `http://localhost` / `http://127.0.0.1` for a local backend. |
| Bundlers | Any, or none — the UMD build works from a script tag |
| Runtime deps | None |

Push has a narrower support surface than events; see the matrix in
[docs/web-push.md](docs/web-push.md#browser-support).

## Install

```bash
npm install @arsel.sa/web-sdk
```

Or from a script tag, which exposes the same surface on `window.Arsel`. unpkg and jsDelivr serve the
UMD build straight from npm — **pin the version**, and add an
[SRI](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity) hash so a
compromised CDN cannot run arbitrary script on your pages:

```html
<script src="https://unpkg.com/@arsel.sa/web-sdk@1.0.0/dist/arsel.umd.cjs"
        integrity="sha384-…" crossorigin="anonymous"></script>
<script>Arsel.init({ clientKey: 'pub_…', baseUrl: 'https://api.arsel.sa' })</script>
```

Or skip the third party altogether: copy `node_modules/@arsel.sa/web-sdk/dist/arsel.umd.cjs` into your
static assets and serve it from your own origin.

For push, also add **one file** to your site — see
[the service worker](docs/quickstart.md#3-add-the-service-worker).

## `clientKey` is publishable, and that is the design

It authenticates the event and push channels and grants nothing else — no reads, no contact list, none
of what a secret API key can do. Every vendor in this category does the same: Klaviyo's site ID,
CleverTap's Account ID, Braze's SDK key, Mixpanel's project token.

**Never put a secret API key in page source.** The residual risk on a publishable key is data
*integrity*, not confidentiality: someone who lifts it could post junk events. Origin allowlisting on
your org is what bounds that — a browser cannot forge its `Origin` header.

## Contributing

```bash
npm install
npm run typecheck        # tsc --noEmit — the gate; there is no lint step
npm test                 # Vitest
npm run build            # dist/arsel.js (ESM) + dist/arsel.umd.cjs
```

## License

MIT.
