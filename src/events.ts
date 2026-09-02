import {
  KEYS,
  QUEUE,
  addEvent,
  allEvents,
  anonymousId,
  get,
  removeEvent,
} from './store';
import type { PendingEvent } from './store';
import { RESULT, post } from './transport';
import type { EventProperties } from './types';

export const EVENTS_PATH = '/v1/events/send';

/** Reserved prefix, so an SDK event can never collide with a customer's. */
export const RESERVED_PREFIX = 'arsel.';
export const EVENT_SESSION_START = `${RESERVED_PREFIX}session_start`;
export const EVENT_SESSION_END = `${RESERVED_PREFIX}session_end`;
export const EVENT_IDENTIFY = `${RESERVED_PREFIX}identify`;
export const EVENT_APP_INSTALLED = `${RESERVED_PREFIX}app_installed`;
/** Screen views share one reserved name; the screen itself is a property. */
export const SCREEN_EVENT = `${RESERVED_PREFIX}screen`;

// Mirror `IngestEventDto`'s @Length caps, applied here so the 400 never happens.
const MAX_EVENT_NAME = 80;
const MAX_ANONYMOUS_ID = 128;
const MAX_EXTERNAL_ID = 255;

/** The batch ceiling `POST /v1/events/send` accepts in an `{ events: [...] }` body. */
export const MAX_BATCH = 50;

const MAX_DATA_DEPTH = 8;
const MAX_DATA_BYTES = 64 * 1024;

/**
 * The backend accepts arbitrary nested JSON, so JSON-safe values pass through
 * unchanged. Dates become ISO strings, non-finite numbers become strings (they
 * are not valid JSON), and functions/symbols/undefined are dropped. The depth
 * cap also terminates cycles.
 */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : String(value);
  if (type === 'bigint') return String(value);
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (type !== 'object' || depth >= MAX_DATA_DEPTH) return undefined;
  if (Array.isArray(value)) {
    // undefined has no JSON form inside an array; null keeps the indices stable.
    return value.map((item) => sanitizeValue(item, depth + 1) ?? null);
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue;
    const clean = sanitizeValue(item, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

/** `data` must be wire-safe JSON, bounded so one huge property cannot 413 the drain. */
function sanitize(properties: EventProperties): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let bytes = 2;
  let dropped = false;
  for (const [key, raw] of Object.entries(properties ?? {})) {
    if (!key) continue;
    const value = sanitizeValue(raw, 0);
    if (value === undefined) continue;
    const cost = key.length + JSON.stringify(value).length + 6;
    if (bytes + cost > MAX_DATA_BYTES) {
      dropped = true;
      continue;
    }
    bytes += cost;
    out[key] = value;
  }
  if (dropped) {
    console.warn(
      `[arsel] event data exceeded ${MAX_DATA_BYTES} serialized bytes — oversized properties were dropped`,
    );
  }
  return out;
}

async function buildBody(
  name: string,
  properties: EventProperties,
  timestampMs: number,
): Promise<string> {
  const [anon, externalId, email, phoneNumber] = await Promise.all([
    anonymousId(),
    get<string>(KEYS.externalId),
    get<string>(KEYS.email),
    get<string>(KEYS.phoneNumber),
  ]);

  const body: Record<string, unknown> = {
    event: name.slice(0, MAX_EVENT_NAME),
    // Always sent, even once identified: it is what the backend merges FROM.
    anonymous_id: anon.slice(0, MAX_ANONYMOUS_ID),
    data: sanitize(properties),
    timestamp: new Date(timestampMs).toISOString(),
  };
  if (externalId) body.external_id = externalId.slice(0, MAX_EXTERNAL_ID);
  if (email) body.email = email;
  if (phoneNumber) body.phone_number = phoneNumber;
  return JSON.stringify(body);
}

/**
 * Persist first, then send. A tab closed mid-flight would otherwise lose the
 * event outright, and page-lifetime-only buffering is the single most common
 * way a web analytics SDK silently undercounts.
 */
export async function enqueue(
  name: string,
  properties: EventProperties,
  timestampMs = Date.now(),
): Promise<void> {
  await addEvent(QUEUE.events, await buildBody(name, properties, timestampMs), crypto.randomUUID());
  // Fire-and-forget: track() must not make the caller wait on the network.
  void flush().catch(() => {});
}

let inFlight: Promise<void> | null = null;

/**
 * Deliver everything queued, oldest first.
 *
 * Serialised, because two concurrent drains would both read the same rows and
 * send each event twice. A caller arriving mid-drain gets the in-flight promise
 * rather than a silent no-op, so `await flush()` actually means "delivered".
 */
export function flush(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = drain().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Deterministic per batch: an identical batch resent after a timeout carries
 * the same key and dedupes inside the backend's 24h window.
 */
function batchKey(batch: PendingEvent[]): string {
  const first = batch[0]!.idempotencyKey;
  if (batch.length === 1) return first;
  return `${first}:${batch[batch.length - 1]!.idempotencyKey}:${batch.length}`;
}

/**
 * A permanent rejection is dropped, but a drop that takes identifiers with it
 * must not be silent — one bad identifier would otherwise 400 every subsequent
 * event with no visible cause.
 */
function reportPermanentDrop(
  items: Record<string, unknown>[],
  code: number,
  body: unknown,
): void {
  const carried = items.some(
    (item) => item.external_id || item.email || item.phone_number,
  );
  if (!carried) return;
  console.error(
    `[arsel] ${items.length} event(s) carrying identifiers were rejected permanently ` +
      `(HTTP ${code}) and dropped. Response: ${JSON.stringify(body)}`,
  );
}

async function drain(): Promise<void> {
  const [clientKey, baseUrl] = await Promise.all([
    get<string>(KEYS.clientKey),
    get<string>(KEYS.baseUrl),
  ]);
  if (!clientKey || !baseUrl) return;

  // Re-reads until the queue is empty: anything enqueued while we were on the
  // network would otherwise sit there until the next unrelated trigger.
  for (;;) {
    const pending = await allEvents(QUEUE.events);
    if (pending.length === 0) return;

    for (let i = 0; i < pending.length; i += MAX_BATCH) {
      const batch = pending.slice(i, i + MAX_BATCH);
      const items = batch.map(
        (event) => JSON.parse(event.body) as Record<string, unknown>,
      );
      const response = await post(
        baseUrl,
        EVENTS_PATH,
        batch.length === 1 ? items[0] : { events: items },
        {
          Authorization: `Bearer ${clientKey}`,
          'Idempotency-Key': batchKey(batch),
        },
      );
      // Stop at the first retryable failure rather than skipping past it — a
      // later batch overtaking an earlier one would reorder a user's history.
      // The whole batch retries under the same key, so a request that landed
      // but timed out on the way back dedupes instead of double-counting.
      if (response.result === RESULT.retryable) return;
      // Success or permanent: either way it is settled. A 4xx will never
      // succeed on a retry, and holding it would wedge everything behind it.
      if (response.result !== RESULT.success) {
        reportPermanentDrop(items, response.code, response.body);
      }
      for (const event of batch) {
        if (event.id !== undefined) await removeEvent(QUEUE.events, event.id);
      }
    }
  }
}
