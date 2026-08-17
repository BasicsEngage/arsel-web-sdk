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
const DB_VERSION = 1;
const KV_STORE = 'kv';
const EVENT_STORE = 'events';

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
      if (!db.objectStoreNames.contains(EVENT_STORE)) {
        db.createObjectStore(EVENT_STORE, { keyPath: 'id', autoIncrement: true });
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

export function addEvent(body: string, idempotencyKey: string): Promise<unknown> {
  return tx(EVENT_STORE, 'readwrite', (s) =>
    s.add({ body, idempotencyKey, createdAtMs: Date.now() }),
  );
}

export function allEvents(): Promise<PendingEvent[]> {
  return tx<PendingEvent[]>(EVENT_STORE, 'readonly', (s) => s.getAll());
}

export function removeEvent(id: number): Promise<unknown> {
  return tx(EVENT_STORE, 'readwrite', (s) => s.delete(id));
}

export function countEvents(): Promise<number> {
  return tx<number>(EVENT_STORE, 'readonly', (s) => s.count());
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
  sessionStartedAt: 'session_started_at',
  backgroundedAt: 'backgrounded_at',
  lastResponseCode: 'last_response_code',
  lastResponsePath: 'last_response_path',
  lastResponseAtMs: 'last_response_at',
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
