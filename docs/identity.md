# Identity

How a browser becomes a person, and what happens to the history it built before it had a name.

## The two ids, and why they are not one id

| | Names | Rotated by `reset()` | Use it as |
| --- | --- | --- | --- |
| `anonymousId` | the **person** using this browser | **yes** | the pre-login identity |
| `installationId` | the **browser profile** | no | a push destination |

They look interchangeable and are not. The installation id survives logout on purpose — it is still
the same browser, and its push subscription is still valid. If you used it as a user identifier, the
next person on a shared computer would inherit the previous one's history and, worse, their
notifications. Every "why did my colleague get my order confirmation" bug is this one.

The SDK keeps them apart so you don't have to think about it: `reset()` rotates the anonymous id and
leaves the installation subscribed.

## Anonymous first

The first time `init()` runs, the SDK mints a UUID and stores it. Every event carries it, including
after you identify — it is what the backend merges *from*.

```
first visit          →  anonymous_id: 9f2c…            (a contact exists already)
track('viewed')      →  anonymous_id: 9f2c…
track('added')       →  anonymous_id: 9f2c…
identify(ext: u_42)  →  anonymous_id: 9f2c…, external_id: u_42
                        ↳ history merges onto the contact known as u_42
track('purchased')   →  anonymous_id: 9f2c…, external_id: u_42
```

An anonymous visitor is a real contact from the first event, not a placeholder that becomes one
later. That is what makes "abandoned cart for a visitor who never logged in" an addressable audience.

## `identify()`

```js
Arsel.identify({ externalId: 'user_10294' });                          // preferred
Arsel.identify({ email: 'sara@example.com' });
Arsel.identify({ externalId: 'user_10294', email: 'sara@example.com' });
```

Call it **once per login**, not per event. The identifiers are stored and ride every later event
automatically. They are validated at the door: `phoneNumber` must be E.164 (`+966501234567`) and
`email` must look like an email address — an invalid value is rejected with a `console.error` and
not stored, because a stored bad identifier would get every subsequent event rejected.

It is a client-side assertion — the browser is claiming who it is. That is appropriate for a value
your own app already knows, and it is the default path. Two other bindings exist:

- **At push registration**, the subscription automatically carries the browser's `anonymousId` —
  the same id the events API sends — so a web subscription binds to the contact the browser's
  events resolve to, with no extra call from you.
- **Server-to-server**, where the backend must be the authority: create or update the contact from
  your own backend via `POST /v1/contacts` with the same `external_id` you assert from the page.
  A contact bound that way simply adopts the browser's events when `identify()` asserts the id.

### Prefer `externalId` alone

Three reasons, in order of how much they'll cost you later:

1. **It doesn't change.** People change email addresses and phone numbers. Your own primary key
   doesn't. Every identifier that can change is a future duplicate contact.
2. **It ranks highest** of the client-assertable identifiers, so it wins every merge decision.
3. **It keeps PII out of page script.** `identify({ email })` puts an address in the DOM's reach —
   readable by every third-party tag on the page.

Which value to use is the one thing worth pausing on when you're migrating:

> Use **your own** user id — the primary key in your database — not your previous vendor's id.
> Your id is the one you can look up, join on, and re-assert from a server-side import. A vendor's
> id is only meaningful inside a platform you are leaving.

## The identifier ladder

When more than one identifier is present, they are ranked:

| Rank | Identifier | Assertable from the browser |
| --- | --- | --- |
| 1 | `contactId` | no — server-side only |
| 2 | `externalId` | yes |
| 3 | `email` | yes |
| 4 | `phoneNumber` | yes |
| 5 | `anonymousId` | yes |

Rank decides two things: which contact wins when several match, and which one absorbs the other.

## What happens on a merge

Given the identifiers on one event, the backend looks up a contact for each, then:

**Nothing matches** → a contact is created carrying every identifier you sent.

**One matches** → that contact is used, and any identifier you sent that it doesn't already have is
**written onto it** — never over an existing value. This is *adoption*: a contact that was created
from an email import picks up its `externalId` the first time you identify with one, and stops being
a duplicate waiting to happen.

**Several match, and the weaker one is recognized by nothing stronger than the identifier that
matched it** → the weaker contact is merged into the stronger one. Its events, its list
memberships and its properties move.

**Several match, and the weaker one is *also* known by something stronger** → **no merge**, and the
conflict is logged. The event attaches to the highest-ranked match.

That last case is deliberate and it is the rule that keeps identity from silently corrupting itself.
An example:

```
Contact A:  externalId u_42,  email sara@example.com
Contact B:  externalId u_99,  email sara@work.example.com

identify({ externalId: 'u_42', email: 'sara@work.example.com' })
```

`externalId` matches A. `email` matches B. B has its own `externalId`, so B is not "just an email
address that happens to match" — merging would destroy a real, separately-identified person. The
event goes to A, B is untouched, and the conflict is recorded rather than resolved by guesswork.

**Merges do not run backwards.** Once two contacts are one, splitting them is not an operation.
This is why the conservative rule exists.

## `reset()`

```js
Arsel.reset();
```

On logout. It:

- forgets `externalId`, `email`, `phoneNumber`
- **rotates the anonymous id**, so the next person's events do not attach to the last person's contact
- forgets the current session, so the next visitor opens a new one

It deliberately does **not** unsubscribe from push. The backend's opt-out is durable and
non-resurrectable by design, so a logout that called it would permanently kill push on that machine
for everyone who used it afterwards — including the same user when they sign back in. Logout and
"stop sending me notifications" are different intents; only the second one is an opt-out.

| You want | Call |
| --- | --- |
| The user signed out | `Arsel.reset()` |
| The user asked to stop receiving notifications | `Arsel.optOut()` — durable, server-side, non-resurrectable |

## Identity across devices

Two browsers identified with the same `externalId` resolve to the same contact. The anonymous
history each built before login merges onto it as each one identifies. There is no cross-device
linking before that: two anonymous browsers are two people until one of them says otherwise.

## Common mistakes

| Mistake | What it causes |
| --- | --- |
| `identify()` on every page view | No harm, but pointless — identifiers persist. |
| `identify()` with a value the user can choose | Anyone can claim anyone's contact. Use a server-issued id. |
| `reset()` on page unload | A fresh identity on every visit; every returning visitor looks new. |
| Using `installationId` as the user id | Shared-device history and notification leaks. |
| Identifying with your old vendor's id | You inherit a key you can't join on and can't re-assert. |
| Never calling `reset()` | On shared machines, one contact accumulates several people. |
