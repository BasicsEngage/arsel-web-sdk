import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENTS_PATH,
  MAX_BATCH,
  RESERVED_PREFIX,
  enqueue,
  flush,
} from '../src/events';
import { KEYS, allEvents, anonymousId, removeEvent, set } from '../src/store';

const BASE_URL = 'https://api.example.com';
const CLIENT_KEY = 'pub_test';

function mockFetch(status = 202, body: unknown = { id: 'log-1' }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function clearEvents() {
  for (const e of await allEvents()) {
    if (e.id !== undefined) await removeEvent(e.id);
  }
}

/** Queue events without letting enqueue()'s own flush deliver them. */
async function enqueueOffline(names: string[]) {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  for (const name of names) await enqueue(name, {});
  await flush().catch(() => {}); // join any in-flight drain before swapping fetch
}

describe('event bodies', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await clearEvents();
    await set(KEYS.clientKey, CLIENT_KEY);
    await set(KEYS.baseUrl, BASE_URL);
    await set(KEYS.externalId, null);
    await set(KEYS.email, null);
  });

  it('always carries the anonymous id, even once identified', async () => {
    // It is what the backend merges FROM. Dropping it once the user is known
    // would strand every event tracked before they logged in.
    await set(KEYS.externalId, 'u_1');
    const fetchMock = mockFetch();

    await enqueue('product.viewed', {});
    await flush();

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.anonymous_id).toBe(await anonymousId());
    expect(body.external_id).toBe('u_1');
  });

  it('omits unset identifiers rather than sending nulls', async () => {
    const fetchMock = mockFetch();

    await enqueue('product.viewed', {});
    await flush();

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).not.toHaveProperty('external_id');
    expect(body).not.toHaveProperty('email');
  });

  it('passes structured JSON through and round-trips it intact', async () => {
    const fetchMock = mockFetch();

    await enqueue('order.placed', {
      sku: 'A-1',
      total: 149.99,
      vip: true,
      tags: ['a', 'b'],
      dims: { w: 10, h: 20, nested: { deep: true } },
      nothing: null,
    });
    await flush();

    const { data } = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(data.sku).toBe('A-1');
    expect(data.total).toBe(149.99);
    expect(data.vip).toBe(true);
    expect(data.tags).toEqual(['a', 'b']);
    expect(data.dims).toEqual({ w: 10, h: 20, nested: { deep: true } });
    expect(data.nothing).toBeNull();
  });

  it('converts Dates to ISO strings and drops non-JSON values', async () => {
    const fetchMock = mockFetch();
    const placedAt = new Date('2026-08-13T10:00:00.000Z');

    await enqueue('order.placed', {
      placed_at: placedAt,
      in_list: [placedAt, () => {}, undefined],
      fn: () => {},
      sym: Symbol('x'),
      gone: undefined,
      broken: NaN,
      infinite: Infinity,
    });
    await flush();

    const { data } = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(data.placed_at).toBe('2026-08-13T10:00:00.000Z');
    // undefined has no JSON form inside an array; null keeps indices stable.
    expect(data.in_list).toEqual(['2026-08-13T10:00:00.000Z', null, null]);
    expect(data).not.toHaveProperty('fn');
    expect(data).not.toHaveProperty('sym');
    expect(data).not.toHaveProperty('gone');
    // NaN/Infinity are not valid JSON numbers, so they are stringified rather
    // than becoming JSON null, which the schema check would then misread.
    expect(typeof data.broken).toBe('string');
    expect(typeof data.infinite).toBe('string');
  });

  it('drops oversized properties rather than sending an unbounded body', async () => {
    const fetchMock = mockFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await enqueue('big.event', { keep: 'small', huge: 'x'.repeat(70 * 1024) });
    await flush();

    const { data } = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(data.keep).toBe('small');
    expect(data).not.toHaveProperty('huge');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('authenticates with the client key and stamps SDK + idempotency headers', async () => {
    const fetchMock = mockFetch();

    await enqueue('product.viewed', {});
    await flush();

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(BASE_URL + EVENTS_PATH);
    expect(options.headers.Authorization).toBe(`Bearer ${CLIENT_KEY}`);
    expect(options.headers['X-Arsel-SDK']).toMatch(/^web\/\d+\.\d+\.\d+$/);
    expect(options.headers['Idempotency-Key']).toBeTruthy();
  });
});

describe('batching and idempotency', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await clearEvents();
    await set(KEYS.clientKey, CLIENT_KEY);
    await set(KEYS.baseUrl, BASE_URL);
    await set(KEYS.externalId, null);
    await set(KEYS.email, null);
  });

  it('sends several events as one { events: [...] } batch, in order', async () => {
    await enqueueOffline(['first', 'second', 'third']);
    const rows = await allEvents();
    const fetchMock = mockFetch();

    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(options.body as string);
    expect(body.events.map((e: { event: string }) => e.event)).toEqual([
      'first',
      'second',
      'third',
    ]);
    // Deterministic batch key: first + last member keys + count, so an
    // identical resend dedupes in the backend's idempotency window.
    expect(options.headers['Idempotency-Key']).toBe(
      `${rows[0]!.idempotencyKey}:${rows[2]!.idempotencyKey}:3`,
    );
    expect(await allEvents()).toHaveLength(0);
  });

  it('a single event keeps the single-object body and its own key', async () => {
    await enqueueOffline(['only']);
    const [row] = await allEvents();
    const fetchMock = mockFetch();

    await flush();

    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(options.body as string);
    expect(body.event).toBe('only');
    expect(body).not.toHaveProperty('events');
    expect(options.headers['Idempotency-Key']).toBe(row!.idempotencyKey);
  });

  it(`splits the drain into requests of at most ${MAX_BATCH}`, async () => {
    await enqueueOffline(Array.from({ length: MAX_BATCH + 10 }, (_, i) => `e${i}`));
    const fetchMock = mockFetch();

    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const second = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(first.events).toHaveLength(MAX_BATCH);
    expect(second.events).toHaveLength(10);
    expect(await allEvents()).toHaveLength(0);
  });

  it('retries the whole batch under the same idempotency key', async () => {
    await enqueueOffline(['first', 'second']);

    const failMock = mockFetch(503);
    await flush();
    expect(await allEvents()).toHaveLength(2);
    const firstKey = failMock.mock.calls[0]![1].headers['Idempotency-Key'];

    const okMock = mockFetch(202);
    await flush();

    expect(okMock.mock.calls[0]![1].headers['Idempotency-Key']).toBe(firstKey);
    expect(await allEvents()).toHaveLength(0);
  });
});

describe('durability', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await clearEvents();
    await set(KEYS.clientKey, CLIENT_KEY);
    await set(KEYS.baseUrl, BASE_URL);
    await set(KEYS.externalId, null);
    await set(KEYS.email, null);
    await set(KEYS.phoneNumber, null);
  });

  it('persists before sending, so a closed tab does not lose the event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await enqueue('product.viewed', {});
    await flush();

    expect(await allEvents()).toHaveLength(1);
  });

  it('keeps a retryable failure queued', async () => {
    mockFetch(503);

    await enqueue('product.viewed', {});
    await flush();

    expect(await allEvents()).toHaveLength(1);
  });

  it('drops a permanent failure instead of blocking everything behind it', async () => {
    // A 400 will never succeed on a retry. Holding it would wedge the queue.
    mockFetch(400);

    await enqueue('product.viewed', {});
    await flush();

    expect(await allEvents()).toHaveLength(0);
  });

  it('logs loudly when a permanent failure takes identifiers with it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await set(KEYS.phoneNumber, '+966501234567');
    mockFetch(400, { message: 'phone_number must be E.164' });

    await enqueue('product.viewed', {});
    await flush();

    expect(await allEvents()).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('phone_number must be E.164'),
    );
    error.mockRestore();
  });

  it('drops identifier-less permanent failures silently', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch(400);

    await enqueue('product.viewed', {});
    await flush();

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('stops at the first retryable failure to preserve order', async () => {
    await enqueueOffline(
      Array.from({ length: MAX_BATCH + 5 }, (_, i) => `e${i}`),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);

    await flush();

    // First batch delivered, second failed and kept — a later batch never
    // overtakes an earlier one on the backend.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await allEvents()).toHaveLength(5);
  });
});

describe('reserved namespace', () => {
  it('names the SDK owns are prefixed so a customer can never collide', () => {
    expect(RESERVED_PREFIX).toBe('arsel.');
  });
});
