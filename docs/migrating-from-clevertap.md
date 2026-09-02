# Migrating from CleverTap (web)

This covers the **browser SDK swap**. Bringing existing profiles and devices across is a separate,
server-side bulk import — talk to your Arsel contact to run it. Do that **first**, then ship the
page change described here.

The model is *import, then cut over*. There is no period where both SDKs run side by side.

---

## API mapping

| CleverTap | Arsel |
| --- | --- |
| `clevertap.init(accountId, region)` | `Arsel.init({ clientKey, baseUrl })` |
| `clevertap.event.push('Product viewed', {...})` | `Arsel.track('product.viewed', {...})` |
| `clevertap.onUserLogin.push({ Site: { Identity, Email } })` | `Arsel.identify({ externalId, email })` |
| `clevertap.profile.push({ Site: {...} })` | `Arsel.identify(...)` for identifiers; contact properties are set server-side |
| `clevertap.logout()` | `Arsel.reset()` |
| `clevertap.notifications.push({...})` | `Arsel.promptForPush()` — your own primer UI, not a config object |
| `clevertap.getCleverTapID()` | `Arsel.getAnonymousId()` — **but read the warning below** |
| `clevertap.setLogLevel(3)` | `Arsel.init({ debug: true })` |
| `clevertap.privacy.push({ optOut: true })` | Don't call `init()`; see [Data collection](data-collection.md#consent) |
| `clevertap_sw.js` at your web root | `/arsel-sw.js` at your web root |

### Not one-to-one

**`getCleverTapID()` is not `getAnonymousId()`.** CleverTap's ID identifies the *browser*; ours
identifies the *person* and is rotated by `reset()`. The nearest equivalent to CleverTap's ID is our
`installationId` (in `diagnostics()`), which names the browser profile and survives logout. If you
were using the CleverTap ID as a user key, stop — see [Identity](identity.md).

**There is no `Charged` event.** CleverTap has a special-cased purchase event with an `Items` array.
Arsel has no reserved commerce event; send your own (`order.placed`) and mark it as a conversion in
the dashboard, mapping the revenue property. Line items are not a first-class structure — send one
event per item, or a stringified summary you don't intend to segment on.

**Properties on the profile vs on the event.** CleverTap's `profile.push` writes arbitrary
attributes from the page. Our client channel asserts *identifiers* only; contact properties are written
server-side or by import. That's deliberate — page script is the least trustworthy place to write a
durable customer record from.

---

## Identity mapping

This is the decision that determines whether the migration produces one contact per person or two.

| CleverTap | Arsel | |
| --- | --- | --- |
| `Identity` | `externalId` | **The join key.** Same value in the import and in `identify()` |
| `Email` | `email` | |
| `Phone` | `phoneNumber` | E.164 |
| `objectId` (CleverTap ID) | `installationId` | A **device** id. Never map it to `externalId` |

Two rules, and the whole migration hangs off them:

1. **Import contacts with `external_id` set from CleverTap's `identity` before you ship the page
   change.** Until a contact carries its `external_id`, an `external_id`-only event from the browser
   creates a *second* contact for that person instead of finding the imported one.
2. **`identify()` with exactly the value you imported.** If the import used your database's user id
   and the page identifies with an email address, you get two contacts that only merge by luck.

A contact matched by email or phone that has no `externalId` yet **adopts** the one you assert, so a
list imported by email last month gains its identities as users log in. That's a safety net, not a
plan.

---

## Behaviour differences worth knowing before you ship

### Logging in as a different user

CleverTap's `onUserLogin` creates a brand-new profile when the identity differs from the current one.
Arsel resolves the identifiers against existing contacts and may **merge** — the rules are in
[Identity](identity.md#what-happens-on-a-merge), and ambiguous cases are refused and logged rather
than guessed at.

Practical consequence: call `reset()` on logout. Without it, the next login can assert a second
identity while the first is still stored.

### Event and property naming

CleverTap conventions are title-case with spaces (`Product viewed`, `Charged`). Nothing stops you
carrying those over, but the migration is the cheapest moment you will ever have to normalise. If you
change them, change them everywhere at once — a mixed estate of `Product viewed` and
`product.viewed` is two events forever.

Reserved prefixes differ: CleverTap reserves `wzrk_`, we reserve `arsel.`.

### Lifecycle events

CleverTap's `App Installed` is `arsel.app_installed`. On the web it means the first time the SDK
ever ran in a browser profile — there is no install to observe — so clearing site data re-fires it.
Browsers that already used an older SDK are seeded silently and never get one, which is why
install-based segments start empty at cut-over and fill forward.

`App Uninstalled` and `App Version Changed` have no counterpart.

### Session events

CleverTap emits `Session Concluded` (and App Launched on mobile). We emit `arsel.session_start` and
`arsel.session_end` with a 30-minute background gap, and the end event is emitted on the *next*
visit, backdated. A visitor who never returns produces no end event — a real difference if you built
reporting on session counts.

### Web push subscriptions do not transfer

Not a limitation of either product: a Web Push subscription is encrypted to the sender's VAPID
keypair, so one minted under CleverTap's keys cannot be sent to under ours.

The recovery is better than it sounds. **Notification permission is granted per origin, not per
vendor**, so a browser that already accepted push from your site is not prompted again — the Arsel
service worker subscribes silently on the user's next visit. Plan for web reach to rebuild over days
of normal traffic rather than at cut-over, and don't re-prompt users who already granted permission.

### Historical events don't come across

Behavioural segments start accumulating at cut-over. Profile data and push reachability do transfer;
event history does not. If you have segments defined on "did X in the last 90 days", they will be
empty for 90 days. Decide what to do about that before launch, not after.

---

## Cut-over sequence

1. **Import contacts** with `external_id`, and devices, per the bulk-import guide. Verify a sample.
2. **Define any events your backend also sends** in the dashboard. Client-key events auto-define
   themselves; server-key events do not, and will `404`.
3. **Add `/arsel-sw.js`** to your web root and verify it returns 200 with a JS content type.
4. **Swap the page script**: remove the CleverTap snippet and its service worker, add `Arsel.init()`.
   Do not run both — two service workers competing for the same scope is a bad afternoon.
5. **Verify** with `Arsel.diagnostics()` and a real event in the dashboard.
6. **Watch push reach recover** over the following days as returning visitors re-subscribe silently.

## Checklist

- [ ] Contacts imported with `external_id` = CleverTap `identity`
- [ ] The page's `identify({ externalId })` uses that same value
- [ ] `objectId` mapped to device identity, never to `externalId`
- [ ] Opt-outs exported from CleverTap and applied
- [ ] Old CleverTap service worker removed from the web root
- [ ] `reset()` wired to logout
- [ ] Push primer UI in place; no prompt on page load
- [ ] Reporting that depended on event history has a plan for the empty window
