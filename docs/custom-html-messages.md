# Custom HTML Messages — Authoring Contract

The `CUSTOM_HTML` layout renders markup written in the Arsel dashboard instead of a headline, body and buttons. It is the same contract on **web, iOS and Android**: one snippet, three platforms, no per-platform branches.

Requires SDK **1.5.0** on every platform. Older builds never receive a `CUSTOM_HTML` message — the server withholds it rather than sending something the device would drop.

---

## 1. The sandbox

Your markup is not trusted by the SDK, and it is not supposed to be. It renders inside the customer's own app or page, so every platform isolates it:

| Platform | How | What that means |
|---|---|---|
| Web | `<iframe sandbox="allow-scripts">`, **no** `allow-same-origin` | Opaque origin. No access to the host page's DOM, cookies or storage. |
| Android | `WebView` with a null base URL, **no** `addJavascriptInterface` | Opaque origin. No Java object is reachable from the page. |
| iOS | `WKWebView` with a nil base URL, non-persistent data store | Unique origin. No app files or Swift objects are reachable. |

Consequences you should design around:

- **No navigation.** The frame cannot navigate itself or the page around it. A link tap opens in the system browser or a new tab; `location.href = …` does nothing.
- **No storage.** `localStorage`, cookies and IndexedDB are unavailable or discarded. State that must survive belongs in an event, not in the frame.
- **No network to your own origin as same-origin.** An absolute `https://` request works; a same-origin one does not, because there is no origin to be same as.
- **No popups, no modals, no top-level forms.** Use the bridge instead.

### JavaScript is off by default

`Allow JavaScript` is a switch in the composer, and it is **off unless someone turns it on**. A scriptless creative is a much smaller surface and covers most designs — styling, layout, images, links. Turn it on only for animation or interaction.

The switch is a capability the *renderer* withholds. Markup authored without script cannot turn script on for itself.

---

## 2. The bridge

With JavaScript enabled, your markup talks to the SDK through `postMessage`. This is the whole API.

```js
parent.postMessage({ type: 'arsel:dismiss' }, '*');
```

On web your creative is an iframe, so `parent` is the host page. On iOS and Android it is the top-level page, and the SDK injects a shim that listens for exactly these posts and forwards them — so **the same line works everywhere**.

### Messages the SDK accepts

| Message | Effect |
|---|---|
| `{ type: 'arsel:dismiss' }` | Closes the message and reports a dismissal. |
| `{ type: 'arsel:track', event: 'wheel_spun' }` | Records an event, exactly as `Arsel.track()` would. Subject to the same opt-out. |
| `{ type: 'arsel:button', buttonId: 'cta' }` | Runs a button **you defined on the campaign** — records the click and follows its destination. |
| `{ type: 'arsel:submit', submission: { email: 'a@b.c' } }` | Reports answers. Keys are yours; values must be strings. |
| `{ type: 'arsel:resize', height: 420 }` | Sets the message's height in CSS pixels, clamped to 90% of the viewport. |

Anything else is ignored.

### What the bridge will not do

The frame proposes; the host disposes. This is deliberate, and it is what makes it safe to run your markup inside someone else's app:

- **A button is named, never supplied.** `arsel:button` carries an id that must match a button defined on the campaign. The destination comes from the campaign, so markup cannot invent a URL to send people to.
- **Every destination is re-checked.** `javascript:`, `data:`, `vbscript:`, `file:` and `blob:` are refused wherever they appear.
- **Submissions are bounded.** At most 20 fields; keys up to 64 characters; values truncated at 500. A submission of any other shape is dropped rather than queued.
- **Height is clamped.** A message cannot grow past 90% of the viewport, so it can never become an overlay the user cannot escape.
- **Messages are checked against the frame itself.** On web the SDK compares `event.source` to the iframe's own window, so nothing else on the page can forge one.

---

## 3. A worked example

```html
<style>
  body { margin: 0; font-family: system-ui, sans-serif; }
  .card { padding: 24px; border-radius: 12px; background: #fff; text-align: center; }
  button { padding: 12px 20px; border: 0; border-radius: 8px; font: inherit;
           background: #0f172a; color: #fff; cursor: pointer; }
</style>
<div class="card">
  <h1>Claim your reward</h1>
  <button id="claim">Claim it</button>
</div>
<script>
  // Tell the host how tall we actually are, so the message is not letterboxed.
  parent.postMessage({ type: 'arsel:resize', height: document.body.scrollHeight }, '*');

  document.getElementById('claim').onclick = function () {
    parent.postMessage({ type: 'arsel:track', event: 'reward_claimed' }, '*');
    parent.postMessage({ type: 'arsel:dismiss' }, '*');
  };
</script>
```

---

## 4. Inline vs URL

| | Inline | URL |
|---|---|---|
| Stored | On the campaign, capped at 65,536 characters | Only the address |
| Changing it | Edit the campaign | Publish to your host; live messages pick it up |
| Offline | Renders from the cached bundle | Needs the network at display time |
| Scheme | — | **https only.** http is refused: a page fetched in the clear inside an app can be rewritten in transit. |

Prefer **URL** where you can host, especially for anything with images or a large stylesheet. Prefer **inline** for a small self-contained creative that must work offline.

---

## 5. Things that will bite you

- **Give the message a way out.** If your markup has no dismiss control and the campaign's close button is off, the user is stuck. The SDK installs a close button when nothing else dismisses the message, but do not rely on it as a design.
- **The headline still matters.** It is not drawn, but it is the message's accessible name on every platform. A screen reader announces it.
- **Merge tags do not resolve inside your markup.** Personalisation applies to the headline and body only.
- **Test with JavaScript off first.** If the creative works scriptless, ship it scriptless.
- **`height` is not measured for you.** A null-origin frame's content height is unreadable from outside, so send `arsel:resize` or accept the default.
