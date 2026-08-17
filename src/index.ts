import {
  EVENT_IDENTIFY,
  RESERVED_PREFIX,
  enqueue,
  flush,
} from './events';
import * as push from './push';
import * as session from './session';
import {
  KEYS,
  anonymousId,
  countEvents,
  get,
  remove,
  rotateAnonymousId,
  set,
} from './store';
import type {
  ArselConfig,
  ArselDiagnostics,
  ArselIdentity,
  EventProperties,
} from './types';
import { SDK_VERSION } from './version';

export type {
  ArselConfig,
  ArselDiagnostics,
  ArselIdentity,
  EventProperties,
} from './types';
export { SDK_VERSION } from './version';

let ready: Promise<void> | null = null;
let debug = false;

function log(message: string): void {
  if (debug) console.info(`[arsel] ${message}`);
}

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Bounded, memory-only holding pen for `track()` calls made before `init()`.
 * Drained into the durable queue the moment init supplies config.
 */
const PRE_INIT_BUFFER_MAX = 100;
interface BufferedEvent {
  name: string;
  properties: EventProperties;
  timestampMs: number;
}
let preInitBuffer: BufferedEvent[] = [];
let preInitOverflowWarned = false;

function attachFlushTriggers(): void {
  // Without these, events stranded by an offline spell or a backgrounded tab
  // wait for the next track() to happen to fire.
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => void flush().catch(() => {}));
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void flush().catch(() => {});
    });
  }
}

/**
 * Start the SDK. Idempotent — a second call returns the first one's promise, so
 * a framework that mounts twice does not mint two identities.
 *
 * Deliberately does **not** request notification permission. A prompt on page
 * load is what gets an origin permanently blocked by Chrome's abusive-
 * notification heuristics; call {@link promptForPush} from a user gesture.
 */
export function init(config: ArselConfig): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    if (!config.clientKey) throw new Error('Arsel: clientKey is required');
    const localhostHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(
      config.baseUrl ?? '',
    );
    if (!config.baseUrl?.startsWith('https://') && !localhostHttp) {
      throw new Error('Arsel: baseUrl must be HTTPS (http is allowed for localhost only)');
    }
    debug = config.debug ?? false;

    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    await Promise.all([
      set(KEYS.clientKey, config.clientKey),
      set(KEYS.baseUrl, baseUrl),
    ]);
    await anonymousId();

    // Anything tracked before init() moves into the durable queue, in order,
    // with its original timestamps.
    const buffered = preInitBuffer;
    preInitBuffer = [];
    for (const event of buffered) {
      await enqueue(event.name, event.properties, event.timestampMs);
    }

    // Registration is opt-in: unconditionally registering would clobber a
    // PWA's own worker on the same scope and 404-spam events-only sites.
    if (config.serviceWorker === 'external') push.useExternal();
    else if (config.serviceWorkerPath) await push.register(config.serviceWorkerPath);

    session.attach();
    attachFlushTriggers();
    // A background or prerendered page has not been *seen* — the session opens
    // on the visibilitychange (or prerenderingchange → visible) that follows.
    const doc = typeof document !== 'undefined'
      ? (document as Document & { prerendering?: boolean })
      : undefined;
    if (doc?.visibilityState === 'visible' && doc.prerendering !== true) {
      await session.onVisible();
    }

    // Anything stranded by a previous page's close goes out now.
    void flush();
    // Silent: it only acts if the org rotated its keys, and permission is
    // already granted in that case.
    void push.reconcile();
    log(`initialized (sdk ${SDK_VERSION})`);
  })();
  return ready;
}

/**
 * Record something the user did.
 *
 * Needs no notification permission and no push subscription. An event tracked
 * before {@link identify} attaches to the anonymous identity and is merged
 * forward when the user is identified. Events tracked before {@link init} are
 * buffered (up to 100) and enqueued when init supplies the configuration.
 *
 * Names beginning `arsel.` are reserved for the SDK and ignored.
 */
export async function track(
  name: string,
  properties: EventProperties = {},
): Promise<void> {
  const trimmed = name?.trim();
  if (!trimmed) {
    log('track() called with a blank event name — ignoring');
    return;
  }
  if (trimmed.startsWith(RESERVED_PREFIX)) {
    log(`'${RESERVED_PREFIX}' is reserved for the SDK — ignoring '${trimmed}'`);
    return;
  }
  if (!ready) {
    if (preInitBuffer.length >= PRE_INIT_BUFFER_MAX) {
      if (!preInitOverflowWarned) {
        preInitOverflowWarned = true;
        console.warn(
          `[arsel] more than ${PRE_INIT_BUFFER_MAX} events tracked before init() — dropping the rest. Call init() earlier.`,
        );
      }
      return;
    }
    preInitBuffer.push({ name: trimmed, properties, timestampMs: Date.now() });
    return;
  }
  await ready;
  await enqueue(trimmed, properties);
}

/**
 * The person using this browser, as an id you already have.
 *
 * Everything tracked beforehand under the anonymous identity is merged onto the
 * contact this resolves to. Prefer `externalId` alone: it binds a contact
 * without putting an email address into page script, and it survives the user
 * changing their address.
 */
export async function identify(identity: ArselIdentity): Promise<void> {
  await ready;
  let { email, phoneNumber } = identity ?? {};
  const externalId = identity?.externalId;

  // Rejected here rather than stored: one malformed phone number would ride
  // every subsequent event, 400 each one, and silently drop them all.
  if (email && !EMAIL_SHAPE.test(email)) {
    console.error(`[arsel] identify(): '${email}' is not a valid email address — ignored`);
    email = undefined;
  }
  if (phoneNumber && !E164.test(phoneNumber)) {
    console.error(
      `[arsel] identify(): '${phoneNumber}' is not E.164 (e.g. +966501234567) — ignored`,
    );
    phoneNumber = undefined;
  }

  if (!externalId && !email && !phoneNumber) {
    log('identify() needs at least one of externalId, email or phoneNumber');
    return;
  }
  if (externalId) await set(KEYS.externalId, externalId);
  if (email) await set(KEYS.email, email);
  if (phoneNumber) await set(KEYS.phoneNumber, phoneNumber);

  // Sent immediately rather than waiting for the next track(): the merge is
  // what the caller asked for, and deferring it leaves the two contacts split
  // until something unrelated happens to fire.
  await enqueue(EVENT_IDENTIFY, {});
}

/**
 * Logout. Rotates the anonymous identity so the next person on this browser
 * does not inherit the previous one's history, and forgets the identifiers.
 *
 * Deliberately does **not** unsubscribe from push: the backend's opt-out is
 * durable and non-resurrectable, so a logout that called it would permanently
 * kill push on a shared machine for everyone who used it afterwards. That
 * opt-out exists as {@link optOut}, for the user who asks to stop receiving
 * notifications.
 */
export async function reset(): Promise<void> {
  await ready;
  await Promise.all([
    remove(KEYS.externalId),
    remove(KEYS.email),
    remove(KEYS.phoneNumber),
    remove(KEYS.sessionStartedAt),
  ]);
  await rotateAnonymousId();
  log('identity reset');
}

/**
 * Durable push opt-out for this browser — "stop sending me notifications", not
 * logout. The revocation is server-side and non-resurrectable: a later
 * registration of the same installation does not undo it. Re-opt-in is an
 * explicit, separate act on the backend.
 *
 * Returns false when this browser never completed a push registration (there
 * is nothing to revoke) or the request failed.
 */
export async function optOut(): Promise<boolean> {
  await ready;
  const revoked = await push.optOut();
  log(revoked ? 'push opt-out recorded' : 'push opt-out not sent — no registration to revoke');
  return revoked;
}

/**
 * Ask for notification permission and subscribe. **Call this from a click**, not
 * on page load.
 *
 * Returns false when the user declines, the browser has no support, or the org
 * does not have the web channel switched on. Declining is a normal outcome, not an
 * error: the contact and its events exist either way.
 */
export async function promptForPush(): Promise<boolean> {
  await ready;
  if (!push.isSupported()) return false;
  // Verified BEFORE prompting: a broken worker setup would otherwise burn the
  // origin's one real permission prompt on a subscription that can never settle.
  const problem = await push.preflight();
  if (problem) {
    console.error(`[arsel] promptForPush(): ${problem}`);
    return false;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    log(`notification permission: ${permission}`);
    return false;
  }
  return push.subscribe();
}

/** The identity events carry before login. Rotated by {@link reset}. */
export async function getAnonymousId(): Promise<string> {
  await ready;
  return anonymousId();
}

/** A snapshot safe to paste into a support ticket — no secrets in it. */
export async function diagnostics(): Promise<ArselDiagnostics> {
  const [
    anon,
    externalId,
    email,
    phoneNumber,
    installationId,
    deviceSecret,
    keyVersion,
    pendingEvents,
    subscribed,
    lastResponseCode,
    lastResponsePath,
    lastResponseAtMs,
  ] = await Promise.all([
    get<string>(KEYS.anonymousId),
    get<string>(KEYS.externalId),
    get<string>(KEYS.email),
    get<string>(KEYS.phoneNumber),
    get<string>(KEYS.installationId),
    get<string>(KEYS.deviceSecret),
    get<number>(KEYS.vapidKeyVersion),
    countEvents(),
    push.isSubscribed(),
    get<number>(KEYS.lastResponseCode),
    get<string>(KEYS.lastResponsePath),
    get<number>(KEYS.lastResponseAtMs),
  ]);

  return {
    sdkVersion: SDK_VERSION,
    initialized: ready !== null,
    anonymousId: anon,
    hasAssertedIdentity: Boolean(externalId || email || phoneNumber),
    installationId,
    hasDeviceSecret: Boolean(deviceSecret),
    pendingEvents,
    permission: push.isSupported() ? Notification.permission : 'unsupported',
    isSubscribed: subscribed,
    vapidKeyVersion: keyVersion,
    lastResponseCode,
    lastResponsePath,
    lastResponseAtMs,
  };
}

/** Deliver anything queued now, rather than on the next natural drain. */
export async function flushNow(): Promise<void> {
  await ready;
  await flush();
}

export const Arsel = {
  init,
  track,
  identify,
  reset,
  optOut,
  promptForPush,
  getAnonymousId,
  diagnostics,
  flushNow,
  SDK_VERSION,
};

export default Arsel;
