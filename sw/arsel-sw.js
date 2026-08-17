/**
 * Arsel service worker.
 *
 * Self-hosted: copy this file (exported as `@arsel.sa/web-sdk/sw`, i.e.
 * `node_modules/@arsel.sa/web-sdk/sw/arsel-sw.js`) to your web root as
 * `/arsel-sw.js`, or `importScripts()` it from your own service worker.
 *
 * It has to be served from the root because service worker scope is a browser
 * rule: a worker served from /js/ can only control /js/.
 *
 * This file runs with no page open, which is the whole reason it reads state
 * from IndexedDB rather than being handed it: a `delivered` engagement has to fire
 * for a push that arrives while the browser has no tab on your site at all.
 */

// Duplicated from src/ on purpose — this file is served as-is, uncompiled, and
// cannot import from the SDK build. Change a constant there, change it here.
const SDK_VERSION = '1.0.0';
const DB_NAME = 'arsel';
const KV_STORE = 'kv';

/** `showNotification` silently drops anything past this in Chrome. */
const MAX_ACTIONS = 2;

/** Never let a slow engagement delay the notification longer than this. */
const ENGAGEMENT_DISPLAY_BUDGET_MS = 1500;

const WIRE = {
  VERSION: 'arsel_v',
  MESSAGE_ID: 'arsel_mid',
  SIGNATURE: 'arsel_sig',
  SIGNATURE_KEY_ID: 'arsel_kid',
  TITLE: 'arsel_title',
  BODY: 'arsel_body',
  IMAGE: 'arsel_image',
  DEEP_LINK: 'arsel_deep_link',
  ACTIONS: 'arsel_actions',
};

// Read-only here. The page's store.ts owns the schema and creates the stores.
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readKeys(keys) {
  const db = await openDb();
  if (!db.objectStoreNames.contains(KV_STORE)) return {};
  const store = db.transaction(KV_STORE, 'readonly').objectStore(KV_STORE);
  const entries = await Promise.all(
    keys.map(
      (key) =>
        new Promise((resolve) => {
          const request = store.get(key);
          request.onsuccess = () => resolve([key, request.result ?? null]);
          request.onerror = () => resolve([key, null]);
        }),
    ),
  );
  return Object.fromEntries(entries);
}

/**
 * Engagements authenticate with the device secret, exactly as the page does. A
 * missing secret means registration never landed — there is nothing to send
 * with, and retrying would only produce 404s.
 */
async function reportEngagements(records) {
  const state = await readKeys([
    'base_url',
    'client_key',
    'installation_id',
    'device_secret',
  ]);
  if (!state.base_url || !state.client_key || !state.installation_id) return;
  if (!state.device_secret) return;

  try {
    await fetch(
      `${state.base_url}/api/v1/orgs/${state.client_key}/push/engagements`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Arsel-Device-Auth': state.device_secret,
          'X-Arsel-SDK': `web/${SDK_VERSION}`,
        },
        credentials: 'omit',
        body: JSON.stringify({
          installationId: state.installation_id,
          events: records,
        }),
      },
    );
  } catch {
    // An engagement is a report, not the delivery itself. Failing it must never stop
    // the notification from being shown.
  }
}

function record(data, eventType, extra = {}) {
  return {
    messageId: data[WIRE.MESSAGE_ID],
    eventType,
    timestamp: new Date().toISOString(),
    // Carried through so push conversion attribution can verify the send.
    // Without them every engagement lands as `signatureStatus: absent` and revenue
    // attribution silently never fires, while engagement counts keep working.
    signature: data[WIRE.SIGNATURE],
    signatureKeyId: data[WIRE.SIGNATURE_KEY_ID],
    ...extra,
  };
}

function parseActions(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    return; // not ours, and not parseable
  }
  // Claimed on arsel_v, with arsel_mid as the fallback — the same test the
  // Android parser applies. There is no marker key on the wire.
  if (!data[WIRE.VERSION] && !data[WIRE.MESSAGE_ID]) return;

  event.waitUntil(
    (async () => {
      // Raced against a short budget: the delivered engagement still goes out, but
      // a slow backend must not hold the notification off the screen.
      const delivered = reportEngagements([record(data, 'delivered')]);
      await Promise.race([
        delivered,
        new Promise((resolve) => setTimeout(resolve, ENGAGEMENT_DISPLAY_BUDGET_MS)),
      ]);

      const actions = parseActions(data[WIRE.ACTIONS]).map((a) => ({
        action: a.actionId,
        title: a.label,
      }));

      try {
        await self.registration.showNotification(data[WIRE.TITLE] || '', {
          body: data[WIRE.BODY] || '',
          image: data[WIRE.IMAGE] || undefined,
          data,
          actions: actions.slice(0, MAX_ACTIONS),
        });
        await reportEngagements([record(data, 'displayed')]);
      } catch {
        // Chrome rejects showNotification() when permission was revoked between
        // subscribe and delivery — reported, not thrown, so it shows up in the
        // org's numbers rather than vanishing.
        await reportEngagements([
          record(data, 'suppressed', { suppressionReason: 'permission_denied' }),
        ]);
      }
      await delivered;
    })(),
  );
});

/**
 * Message ids whose notification was closed *by a tap*. Chrome fires
 * `notificationclose` for the programmatic close() in the click handler too;
 * without this every open/click would also report a `dismissed`.
 * Module scope is safe: the close event fires in the same worker instance,
 * queued right behind the click that caused it.
 */
const tappedMessageIds = new Set();

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  const actionId = event.action || null;
  if (data[WIRE.MESSAGE_ID]) tappedMessageIds.add(data[WIRE.MESSAGE_ID]);
  event.notification.close();

  // Exactly one event. OPENED for the body, CLICKED for an action button — they
  // are separate metrics, and firing both on every tap makes the two counters
  // identical by construction.
  const chosen = parseActions(data[WIRE.ACTIONS]).find(
    (a) => a.actionId === actionId,
  );
  const link = chosen?.deepLink || data[WIRE.DEEP_LINK] || '/';

  event.waitUntil(
    (async () => {
      await reportEngagements([
        record(data, actionId ? 'clicked' : 'opened', {
          actionId: actionId || undefined,
          deepLink: link,
        }),
      ]);

      // Focus an existing tab rather than opening a duplicate.
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      const existing = clients.find((c) => 'focus' in c);
      if (existing) {
        await existing.focus();
        if ('navigate' in existing) await existing.navigate(link).catch(() => {});
        return;
      }
      await self.clients.openWindow(link);
    })(),
  );
});

self.addEventListener('notificationclose', (event) => {
  const data = event.notification.data || {};
  const messageId = data[WIRE.MESSAGE_ID];
  if (!messageId) return;
  // The close that follows a tap is not a dismissal — that tap already sent its
  // one engagement (opened or clicked).
  if (tappedMessageIds.delete(messageId)) return;
  event.waitUntil(reportEngagements([record(data, 'dismissed')]));
});

/**
 * The browser rotates an endpoint on its own schedule. Without this the old
 * endpoint keeps 410-ing and the user goes quietly unreachable — the same
 * failure mode as a VAPID rotation, from the other direction.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const state = await readKeys([
        'base_url',
        'client_key',
        'installation_id',
        'anonymous_id',
      ]);
      if (!state.base_url || !state.client_key || !state.installation_id) return;

      const fresh = event.newSubscription;
      if (!fresh) return; // nothing to report; the page re-subscribes on next init

      const json = fresh.toJSON();
      try {
        await fetch(
          `${state.base_url}/api/v1/orgs/${state.client_key}/push/subscriptions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Arsel-SDK': `web/${SDK_VERSION}`,
            },
            credentials: 'omit',
            body: JSON.stringify({
              installationId: state.installation_id,
              platform: 'web',
              endpoint: json.endpoint,
              keys: json.keys,
              anonymousId: state.anonymous_id || undefined,
              enablementStatus: 'AUTHORIZED',
            }),
          },
        );
      } catch {
        /* the page's reconcile() picks it up on the next visit */
      }
    })(),
  );
});
