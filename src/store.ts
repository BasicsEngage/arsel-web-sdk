/**
 * Shared durable state, in IndexedDB.
 *
 * IndexedDB rather than `localStorage` for one reason that decides it: the
 * service worker has to read the device secret and the client key to report a
 * `delivered` engagement when **no tab is open at all**, and `localStorage` is
 * unreachable from a worker. Splitting state across both stores would put the
 * two halves of one fact in two places.
 */

const DB_NAME = 'arsel';
const DB_VERSION = 2;
const KV_STORE = 'kv';

/**
 * The two durable queues.
 *
 * In-app beacons live in their OWN store, not alongside events. The events
 * drain stops at the first retryable failure to preserve a user's history
 * order — so a single stuck beacon sharing that queue would wedge the entire
 * analytics pipeline behind it.
 */
export const QUEUE = {
  events: 'events',
  inAppBeacons: 'inapp_beacons',
} as const;

export type QueueStore = (typeof QUEUE)[keyof typeof QUEUE];

export interface PendingEvent {
  /** Monotonic within a tab; the auto-increment key doubles as delivery order. */
  id?: number;
  body: string;
  /**
   * Minted once at enqueue and persisted, so a retry of the same event carries
   * the same key and the backend's 24h idempotency window can dedupe it.
   */
  idempotencyKey: string;
  createdAtMs: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      // Guarded by name rather than by version, so a browser installed at v1
      // gains only the store it is missing.
      for (const name of Object.values(QUEUE)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(store, mode).objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export function get<T>(key: string): Promise<T | null> {
  return tx<T | undefined>(KV_STORE, 'readonly', (s) => s.get(key)).then(
    (v) => v ?? null,
  );
}

export function set(key: string, value: unknown): Promise<unknown> {
  return tx(KV_STORE, 'readwrite', (s) => s.put(value, key));
}

export function remove(key: string): Promise<unknown> {
  return tx(KV_STORE, 'readwrite', (s) => s.delete(key));
}

export function addEvent(
  store: QueueStore,
  body: string,
  idempotencyKey = '',
): Promise<unknown> {
  return tx(store, 'readwrite', (s) =>
    s.add({ body, idempotencyKey, createdAtMs: Date.now() }),
  );
}

export function allEvents(store: QueueStore): Promise<PendingEvent[]> {
  return tx<PendingEvent[]>(store, 'readonly', (s) => s.getAll());
}

export function removeEvent(store: QueueStore, id: number): Promise<unknown> {
  return tx(store, 'readwrite', (s) => s.delete(id));
}

export function countEvents(store: QueueStore): Promise<number> {
  return tx<number>(store, 'readonly', (s) => s.count());
}

/** Oldest-first trim, so an offline spell cannot grow the queue without bound. */
export async function trimQueue(
  store: QueueStore,
  max: number,
): Promise<void> {
  const rows = await allEvents(store);
  if (rows.length <= max) return;
  for (const row of rows.slice(0, rows.length - max)) {
    if (row.id !== undefined) await removeEvent(store, row.id);
  }
}

export const KEYS = {
  clientKey: 'client_key',
  baseUrl: 'base_url',
  anonymousId: 'anonymous_id',
  externalId: 'external_id',
  email: 'email',
  phoneNumber: 'phone_number',
  installationId: 'installation_id',
  deviceSecret: 'device_secret',
  vapidKeyVersion: 'vapid_key_version',
  endpoint: 'endpoint',
  subscriptionStatus: 'subscription_status',
  installReported: 'install_reported',
  sessionStartedAt: 'session_started_at',
  backgroundedAt: 'backgrounded_at',
  lastResponseCode: 'last_response_code',
  lastResponsePath: 'last_response_path',
  lastResponseAtMs: 'last_response_at',
  /** `{ bundleVersion, ttlSeconds, fetchedAtMs, messages }` — the cached bundle. */
  inAppBundle: 'inapp_bundle',
  /** messageId -> lifetime counters. Survives `reset()`: it describes the device. */
  inAppState: 'inapp_state',
  /**
   * `{ startedAt, counts }`. Persisted rather than held in memory so
   * `maxPerSession` survives a navigation — on a multi-page site an in-memory
   * counter makes the cap per-page, which is not a cap at all.
   */
  inAppSession: 'inapp_session',
} as const;

/**
 * Person-shaped identity, minted on first use. Distinct from the installation
 * id, which names the browser profile: this one names whoever is using it and
 * is rotated by `reset()`, so a shared computer does not hand the next person
 * the previous one's history.
 */
export async function anonymousId(): Promise<string> {
  const existing = await get<string>(KEYS.anonymousId);
  if (existing) return existing;
  const minted = crypto.randomUUID();
  await set(KEYS.anonymousId, minted);
  return minted;
}

export async function rotateAnonymousId(): Promise<string> {
  const minted = crypto.randomUUID();
  await set(KEYS.anonymousId, minted);
  return minted;
}
