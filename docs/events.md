# Events

## Tracking

```js
Arsel.track('product.viewed', { sku: 'A-1023', price: 149.99, in_stock: true });
```

No push permission, no subscription, no service worker. An event tracked before `identify()`
attaches to the anonymous identity and is merged forward when the user is identified.

`track()` returns a promise that resolves once the event is **persisted**, not once it is delivered.
It never rejects and never makes the caller wait on the network. If you need delivery, `flushNow()`.

Calls made before `init()` are buffered in memory (up to 100) and moved into the durable queue, in
order and with their original timestamps, when `init()` runs. The buffer is page-lifetime only —
initialize early.

### You do not have to define the event first

An event name that doesn't exist in your org **defines itself** on first receipt from a client key,
with an empty schema. This is deliberate: a shipped browser bundle cannot be redeployed to fix a
rejection, so a name the dashboard hasn't seen is accepted rather than refused.

The same is not true of the server-side API, where an undefined event name is a `404`. If you send
the same event from both your backend and the browser, define it in the dashboard first.

Schema mismatches from a client key are also **recorded, not rejected** — the event is stored with
its validation errors attached, so you can see the drift in the dashboard instead of losing the data.

## Naming

There is no enforced convention, so pick one and hold it. `noun.verb_past` reads well in a
segment builder and sorts usefully:

```
product.viewed        cart.updated       checkout.started
order.placed          order.refunded     subscription.cancelled
```

Names are **case-sensitive**: `Product.Viewed` and `product.viewed` are two events and will sit next
to each other in your dashboard forever.

| Rule | |
| --- | --- |
| Max length | 80 characters (truncated, not rejected) |
| Reserved | anything starting `arsel.` — ignored, with a console warning under `debug` |
| Blank | ignored |

## Properties

```js
Arsel.track('order.placed', {
  order_id: 'A-1023',                          // string
  total: 149.99,                               // number
  currency: 'SAR',                             // string
  is_gift: false,                              // boolean
  items: [{ sku: 'A-1', qty: 2 }],             // nested JSON, sent as-is
  placed_at: new Date(),                       // → ISO-8601 string
});
```

| Type | Sent as |
| --- | --- |
| `string`, finite `number`, `boolean`, `null` | as-is |
| array, object | as-is — arbitrary nested JSON, sanitized recursively (max depth 8) |
| `Date` | ISO-8601 string (`toISOString()`) |
| `undefined`, function, symbol | dropped (`null` inside an array, to keep indices stable) |
| `NaN`, `Infinity`, bigint | stringified (they are not valid JSON numbers) |

Keys with empty names are dropped. Serialized `data` is capped at **64 KB** — properties that would
push past it are dropped with a console warning rather than failing the whole event. Nested objects
are **not** flattened — if you need `items[0].sku` to be queryable in the segment builder, also
send it as a top-level property or one event per item.

### What not to put in a property

- **Passwords, tokens, card numbers, national IDs.** Events are long-lived analytical records.
- **Whole API responses.** They stringify to something no one can segment on.
- **A value that is really an identifier.** `identify()` is where identifiers go; a `user_id`
  property does not bind anything.

## Reserved events

The SDK emits these itself. Your `track()` cannot create or overwrite them.

| Event | When | Properties |
| --- | --- | --- |
| `arsel.app_installed` | the first time the SDK ever runs in this browser profile | `sdk_version`, `platform` |
| `arsel.session_start` | a visit begins, or resumes after 30+ minutes away | — |
| `arsel.session_end` | discovered on the **next** visit, backdated to when the page went away | `duration_seconds` |
| `arsel.identify` | `identify()` supplied at least one identifier | — |
| `arsel.screen_view` | `screen()` was called | `screen_name`, plus whatever you passed |

## Installs

A browser has no install step, so `arsel.app_installed` means *the first time we ever saw this
device* — the honest analogue of what the mobile SDKs report, and it fires ahead of the first
`arsel.session_start` so the install leads the timeline.

Two consequences worth knowing before you build a funnel on it:

> **Clearing site data or opening a private window re-fires it.** The flag lives in the same
> IndexedDB the rest of the SDK uses, so a wiped profile is a new device by every measure available
> to a page. Web install counts run high by exactly that much, and nothing inside the page can fix
> it.

> **Browsers that were already using an older SDK never get one.** They are seeded silently on their
> first load after upgrading. Emitting instead would have reported the entire existing audience as
> installs on the day you shipped the upgrade — so "installed in the last 30 days" excludes anyone
> who arrived before this event existed.

## Sessions

A session ends after **30 minutes** hidden — the industry-standard gap. Shorter gaps read a tab
switch or a phone unlocking as a boundary and inflate every session count you have.

Sessions also open only for pages actually **seen**: a tab loaded in the background, or a page the
browser prerendered speculatively, does not emit `arsel.session_start` until it becomes visible.

The end event is emitted on the *next* visible transition, backdated to when the page actually went
away — there is no timer. A timer would have to survive the tab being frozen or discarded, which is
exactly when it matters.

The consequence is the standard one, and it is worth stating plainly because it looks like a bug:

> **Someone who closes the tab and never returns produces no `arsel.session_end`.** An
> open-but-unclosed session is better than a fabricated end time.

Session boundaries come from `visibilitychange` and `pagehide`. `pagehide` rather than `unload`
because `unload` does not reliably fire on mobile Safari.

## Delivery and durability

Events are written to IndexedDB **before** being sent. A tab closed mid-flight does not lose them;
page-lifetime-only buffering is the single most common way a web analytics SDK silently undercounts.

The queue drains oldest-first, in batches of up to **50 events per request**, and:

- **stops at the first retryable failure**, so a later event never overtakes an earlier one and
  reorders a user's history;
- **discards permanent failures** rather than wedging everything behind them — and when a dropped
  request carried identifiers, it logs the response body with `console.error` so the cause is
  visible instead of silently losing events;
- **dedupes retries**: every event gets a persisted idempotency key at enqueue, every request an
  `Idempotency-Key` derived from its members, so a request that landed but timed out on the way
  back is deduplicated by the backend (24-hour window) instead of double-counted;
- **re-reads after each pass**, so anything enqueued while it was on the network goes out in the
  same drain;
- **runs one drain at a time**. Concurrent drains would send every event twice.

### Retry policy

| Response | Treated as |
| --- | --- |
| `2xx` | delivered |
| `408`, `429`, `5xx` | retryable — kept, retried later |
| `404` | retryable — an org whose channel isn't switched on yet answers this, and giving up would strand a browser that would have worked tomorrow |
| no response (offline, DNS, TLS) | retryable |
| any other `4xx` | permanent — dropped |

There is no exponential backoff timer in the page. A drain is triggered by `track()`, by `init()`,
by `flushNow()`, by the browser coming back **online**, and by the tab becoming **visible** again.
In practice anything stranded goes out the moment connectivity or attention returns.

### Forcing a flush

```js
await Arsel.flushNow();
```

Waits for the queue to actually empty (or hit a retryable failure). Useful before a redirect to an
external payment page, and in tests. Not needed in normal operation.

## Limits

| | Limit | Over the limit |
| --- | --- | --- |
| Event name | 80 chars | truncated |
| `anonymous_id` | 128 chars | truncated |
| `external_id` | 255 chars | truncated |
| Serialized `data` per event | 64 KB | oversized properties dropped, with a console warning |
| Property nesting depth | 8 levels | deeper values dropped |
| Events per delivery request | 50 | split into multiple requests |
| Pre-init buffer | 100 events | further pre-init events dropped, with a console warning |
| Queued events | no hard cap | bounded in practice by IndexedDB quota |

The SDK truncates rather than rejects, because the API's validation caps are the same numbers and a
`400` from a shipped bundle is unfixable from your side.

## Debugging

```js
await Arsel.init({ clientKey, baseUrl, debug: true });
```

Logs SDK decisions to the console — ignored reserved names, permission outcomes, identity resets.
Leave it off in production; it is noise, not telemetry.

```js
console.table(await Arsel.diagnostics());
```

`pendingEvents` is the number that matters. Briefly non-zero is normal. Monotonically growing means
delivery is failing — check `lastResponseCode` against the retry table above.
