import { KEYS, anonymousId, get, set } from './store';
import { RESULT, getJson, post } from './transport';
import type { WebPushConfig } from './types';

/**
 * VAPID keys arrive base64url; `applicationServerKey` wants raw bytes.
 *
 * Returns the ArrayBuffer rather than the view: TS models `BufferSource` as
 * requiring a non-shared buffer, and a `Uint8Array` is only assignable when its
 * backing buffer is statically known not to be a `SharedArrayBuffer`.
 */
function decodeBase64Url(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function isSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof PushManager !== 'undefined' &&
    typeof Notification !== 'undefined'
  );
}

function configPath(clientKey: string): string {
  return `/api/v1/orgs/${clientKey}/push/web/config`;
}

function subscriptionsPath(clientKey: string): string {
  return `/api/v1/orgs/${clientKey}/push/subscriptions`;
}

const ACTIVATION_TIMEOUT_MS = 10_000;

/**
 * How this page gets a service worker, decided once by `init()`:
 * - `none` — events-only integration; every push entry point fails fast.
 * - `managed` — the SDK registered `serviceWorkerPath` and holds the result.
 * - `external` — the customer's own worker `importScripts` arsel-sw.js; the SDK
 *   registers nothing and uses whatever controls the page.
 */
let mode: 'none' | 'managed' | 'external' = 'none';
let managedRegistration: ServiceWorkerRegistration | null = null;
let registrationError: string | null = null;

export function useExternal(): void {
  mode = 'external';
}

export async function register(path: string): Promise<void> {
  if (!isSupported()) return;
  mode = 'managed';
  try {
    // No explicit scope: the default is the path's directory, and forcing '/'
    // throws SecurityError for any worker served from a subpath.
    managedRegistration = await navigator.serviceWorker.register(path);
    registrationError = null;
  } catch (error) {
    managedRegistration = null;
    registrationError =
      `service worker registration failed for '${path}': ${String(error)}. ` +
      'Check that the file is deployed and served with a JavaScript content type.';
  }
}

/**
 * Resolve once the registration has an active worker, or fail with a reason —
 * never `navigator.serviceWorker.ready`, which hangs forever when registration
 * failed and turns every caller into a silent no-op.
 */
function waitForActive(
  registration: ServiceWorkerRegistration,
  timeoutMs: number,
): Promise<ServiceWorkerRegistration> {
  if (registration.active) return Promise.resolve(registration);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `service worker did not activate within ${timeoutMs}ms — ` +
            'check the worker script for load errors in DevTools → Application → Service Workers',
        ),
      );
    }, timeoutMs);
    const watch = (worker: ServiceWorker): void => {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated') {
          clearTimeout(timer);
          resolve(registration);
        } else if (worker.state === 'redundant') {
          clearTimeout(timer);
          reject(
            new Error(
              'service worker became redundant before activating — its script likely failed to parse',
            ),
          );
        }
      });
    };
    const worker = registration.installing ?? registration.waiting;
    if (worker) watch(worker);
    else {
      registration.addEventListener('updatefound', () => {
        if (registration.installing) watch(registration.installing);
      });
    }
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

async function activeRegistration(
  timeoutMs = ACTIVATION_TIMEOUT_MS,
): Promise<ServiceWorkerRegistration> {
  if (mode === 'none') {
    throw new Error(
      "push is not configured — pass serviceWorkerPath to init(), or serviceWorker: 'external' " +
        'if your own service worker imports arsel-sw.js',
    );
  }
  if (mode === 'external') {
    return withTimeout(
      navigator.serviceWorker.ready,
      timeoutMs,
      `no service worker became active within ${timeoutMs}ms — with serviceWorker: 'external', ` +
        'your own worker must be registered and must importScripts arsel-sw.js',
    );
  }
  if (registrationError) throw new Error(registrationError);
  if (!managedRegistration) {
    throw new Error('service worker registration has not completed');
  }
  return waitForActive(managedRegistration, timeoutMs);
}

/**
 * Everything that can be verified *before* the permission prompt, so a broken
 * worker setup fails with a reason instead of burning the origin's one real
 * prompt on a subscription that can never settle.
 *
 * Returns an error message, or null when push can proceed.
 */
export async function preflight(
  timeoutMs = ACTIVATION_TIMEOUT_MS,
): Promise<string | null> {
  try {
    await activeRegistration(timeoutMs);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Subscribe this browser and register it with Arsel.
 *
 * Only ever called from a user gesture path — `subscribe()` triggers the
 * permission prompt, and a prompt fired on page load is what gets an origin
 * permanently blocked in Chrome's abusive-notification heuristics.
 */
export async function subscribe(): Promise<boolean> {
  const [clientKey, baseUrl] = await Promise.all([
    get<string>(KEYS.clientKey),
    get<string>(KEYS.baseUrl),
  ]);
  if (!clientKey || !baseUrl || !isSupported()) return false;

  const config = await getJson<WebPushConfig>(baseUrl, configPath(clientKey));
  if (!config?.vapidPublicKey) return false;

  let registration: ServiceWorkerRegistration;
  try {
    registration = await activeRegistration();
  } catch (error) {
    console.error(`[arsel] ${error instanceof Error ? error.message : error}`);
    return false;
  }
  const subscription = await registration.pushManager.subscribe({
    // Non-negotiable: the Push API only accepts a userVisibleOnly subscription
    // in Chrome, and silent push is what the restriction exists to prevent.
    userVisibleOnly: true,
    applicationServerKey: decodeBase64Url(config.vapidPublicKey),
  });

  return sendSubscription(subscription, config.keyVersion);
}

async function sendSubscription(
  subscription: PushSubscription,
  keyVersion: number,
): Promise<boolean> {
  const [clientKey, baseUrl, anon] = await Promise.all([
    get<string>(KEYS.clientKey),
    get<string>(KEYS.baseUrl),
    anonymousId(),
  ]);
  if (!clientKey || !baseUrl) return false;

  let installationId = await get<string>(KEYS.installationId);
  if (!installationId) {
    installationId = crypto.randomUUID();
    await set(KEYS.installationId, installationId);
  }

  // Posted VERBATIM. Reshaping this object is exactly where an SDK drops the
  // `auth` secret, and every send then fails encryption with no obvious cause.
  const json = subscription.toJSON();

  const response = await post<{ deviceSecret?: string }>(
    baseUrl,
    subscriptionsPath(clientKey),
    {
      installationId,
      platform: 'web',
      endpoint: json.endpoint,
      keys: json.keys,
      // The same id the events API sends — it is what binds this subscription
      // to the contact the browser's events resolve to.
      anonymousId: anon,
      enablementStatus:
        Notification.permission === 'granted' ? 'AUTHORIZED' : 'DENIED',
      deviceTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      deviceLocale: navigator.language,
    },
  );

  if (response.result !== RESULT.success) return false;

  // Issued exactly once, on the call that mints it. Losing it strands this
  // browser without a way to authenticate anything ever again.
  if (response.body?.deviceSecret) {
    await set(KEYS.deviceSecret, response.body.deviceSecret);
  }
  await set(KEYS.vapidKeyVersion, keyVersion);
  await set(KEYS.endpoint, json.endpoint ?? null);
  return true;
}

/**
 * Durable opt-out, mirroring the Android SDK: the backend revocation is
 * non-resurrectable — a later register for this installation will not undo it.
 * Distinct from `reset()`, which never touches push.
 */
export async function optOut(): Promise<boolean> {
  const [clientKey, baseUrl, installationId, deviceSecret] = await Promise.all([
    get<string>(KEYS.clientKey),
    get<string>(KEYS.baseUrl),
    get<string>(KEYS.installationId),
    get<string>(KEYS.deviceSecret),
  ]);
  if (!clientKey || !baseUrl) return false;
  if (!installationId || !deviceSecret) {
    // Never registered — there is nothing server-side to revoke.
    return false;
  }

  const response = await post(
    baseUrl,
    `${subscriptionsPath(clientKey)}/unsubscribe`,
    { installationId },
    { 'X-Arsel-Device-Auth': deviceSecret },
    true,
  );
  return response.result === RESULT.success;
}

/**
 * Re-subscribe silently when the org has rotated its VAPID keypair.
 *
 * Rotation invalidates every live subscription: the browser's endpoint was
 * issued against the old application server key, and pushes to it are refused.
 * Nothing surfaces that to the user, so without this an entire cohort goes
 * quietly unreachable and the org's reach decays with no error anywhere.
 *
 * Safe to call on every init — it is a no-op unless the version actually moved,
 * and it never prompts: permission is already granted at this point, so
 * `subscribe()` resolves without user interaction.
 */
export async function reconcile(): Promise<void> {
  if (mode === 'none') return;
  if (!isSupported() || Notification.permission !== 'granted') return;

  const [clientKey, baseUrl] = await Promise.all([
    get<string>(KEYS.clientKey),
    get<string>(KEYS.baseUrl),
  ]);
  if (!clientKey || !baseUrl) return;

  const config = await getJson<WebPushConfig>(baseUrl, configPath(clientKey));
  if (!config?.vapidPublicKey) return;

  let registration: ServiceWorkerRegistration;
  try {
    registration = await activeRegistration();
  } catch {
    // Opportunistic maintenance; a broken worker surfaces on promptForPush().
    return;
  }
  const existing = await registration.pushManager.getSubscription();
  const knownVersion = await get<number>(KEYS.vapidKeyVersion);

  if (existing && knownVersion === config.keyVersion) return;

  // The old subscription must go first: `subscribe()` with a different
  // applicationServerKey throws InvalidStateError while one is still live.
  if (existing) await existing.unsubscribe().catch(() => false);

  const fresh = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeBase64Url(config.vapidPublicKey),
  });
  await sendSubscription(fresh, config.keyVersion);
}

export async function isSubscribed(): Promise<boolean> {
  if (!isSupported()) return false;
  try {
    // Never `.ready` — it hangs forever when nothing is registered.
    const registration =
      mode === 'managed'
        ? managedRegistration
        : await navigator.serviceWorker.getRegistration();
    if (!registration) return false;
    return (await registration.pushManager.getSubscription()) !== null;
  } catch {
    return false;
  }
}
