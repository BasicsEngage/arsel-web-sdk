import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as inapp from '../src/inapp';
import { KEYS, QUEUE, allEvents, get, set } from '../src/store';

/**
 * The rule engine and the wire contract.
 *
 * Two things here are worth more than the rest: the display-rule ORDER, because
 * a message shown once too often is the complaint that gets a channel switched
 * off; and the beacon shape, because the endpoint runs `forbidNonWhitelisted`
 * and one wrong key 400s a batch of fifty.
 */

const CLIENT_KEY = 'pub_test';
const BASE_URL = 'https://api.test';
const INSTALLATION_ID = 'install-1';
const DEVICE_SECRET = 'secret-1';

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[] = [];

function respond(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status <= 299,
    json: () =>
      body === undefined
        ? Promise.reject(new Error('no body'))
        : Promise.resolve(body),
  } as unknown as Response;
}

function stubFetch(...responses: Response[]): void {
  let index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return Promise.resolve(next);
    }),
  );
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    campaignId: 'c1',
    messageId: 'm1',
    variantKey: 'default',
    priority: 100,
    expiresAt: null,
    trigger: { type: 'APP_OPEN' },
    displayRules: {
      maxPerSession: 1,
      maxLifetime: 3,
      minSecondsBetween: 0,
      delaySeconds: 0,
    },
    layout: 'MODAL',
    content: { headline: 'Hi', body: 'There', showCloseButton: true },
    buttons: null,
    ...overrides,
  };
}

function bundle(messages: unknown[], bundleVersion = 'v1') {
  // The real envelope: the backend's global success interceptor spreads
  // `message` and `timestamp` alongside the contract fields.
  return {
    message: 'success',
    timestamp: '2026-08-19T10:00:00.000Z',
    contractVersion: 1,
    bundleVersion,
    ttlSeconds: 900,
    messages,
  };
}

async function seedAuth(): Promise<void> {
  await Promise.all([
    set(KEYS.clientKey, CLIENT_KEY),
    set(KEYS.baseUrl, BASE_URL),
    set(KEYS.installationId, INSTALLATION_ID),
    set(KEYS.deviceSecret, DEVICE_SECRET),
  ]);
}

async function clearState(): Promise<void> {
  await Promise.all([
    set(KEYS.inAppBundle, undefined),
    set(KEYS.inAppState, {}),
    set(KEYS.inAppSession, { startedAt: 0, counts: {} }),
    set(KEYS.sessionStartedAt, 0),
  ]);
  for (const row of await allEvents(QUEUE.inAppBeacons)) {
    if (row.id !== undefined) {
      const { removeEvent } = await import('../src/store');
      await removeEvent(QUEUE.inAppBeacons, row.id);
    }
  }
}

describe('in-app messaging', () => {
  beforeEach(async () => {
    calls = [];
    vi.unstubAllGlobals();
    await seedAuth();
    await clearState();
    inapp.setSuppressed(false);
    inapp.releaseActive();
  });

  describe('bundle fetch', () => {
    it('sends device auth and cache: no-store', async () => {
      stubFetch(respond(200, bundle([message()])));
      await inapp.start(false);

      const [call] = calls;
      expect(call.url).toContain(`/api/v1/orgs/${CLIENT_KEY}/in-app/bundle`);
      expect(call.url).toContain(`installationId=${INSTALLATION_ID}`);
      // Without no-store the browser revalidates on its own and hands back a
      // synthesized 200; our If-None-Match never reaches the server.
      expect(call.init.cache).toBe('no-store');
      const headers = call.init.headers as Record<string, string>;
      expect(headers['X-Arsel-Device-Auth']).toBe(DEVICE_SECRET);
    });

    it('keeps the cached bundle on a 304 and does not discard it', async () => {
      stubFetch(respond(200, bundle([message()])), respond(304, undefined));
      await inapp.start(false);
      expect(inapp.snapshot().messages).toBe(1);

      await inapp.refresh(true);

      // classify() maps 304 to `permanent`; routing it through that table would
      // throw the cache away on every successful revalidation.
      expect(inapp.snapshot().messages).toBe(1);
      expect(inapp.snapshot().bundleVersion).toBe('v1');
    });

    it('sends If-None-Match once a bundle is cached', async () => {
      stubFetch(respond(200, bundle([message()])), respond(304, undefined));
      await inapp.start(false);
      await inapp.refresh(true);

      const headers = calls[1].init.headers as Record<string, string>;
      expect(headers['If-None-Match']).toBe('"v1"');
    });

    it('makes exactly one request for two concurrent refreshes', async () => {
      stubFetch(respond(200, bundle([message()])));
      await inapp.start(false);
      calls = [];

      await Promise.all([inapp.refresh(true), inapp.refresh(true)]);

      // The endpoint is throttled per ORG but not per device: one browser
      // refetching in a loop can 429 every other device in the org.
      expect(calls).toHaveLength(1);
    });

    it('does not refetch inside the bundle TTL', async () => {
      stubFetch(respond(200, bundle([message()])));
      await inapp.start(false);
      calls = [];

      await inapp.refresh();

      expect(calls).toHaveLength(0);
    });

    it('keeps the cache when the request fails', async () => {
      stubFetch(respond(200, bundle([message()])), respond(500, undefined));
      await inapp.start(false);

      await inapp.refresh(true);

      expect(inapp.snapshot().messages).toBe(1);
    });
  });

  describe('parser', () => {
    it('accepts absent, null and present for every optional field', async () => {
      stubFetch(
        respond(
          200,
          bundle([
            message({ messageId: 'absent' }),
            message({
              messageId: 'nulls',
              expiresAt: null,
              buttons: null,
              trigger: { type: 'APP_OPEN', eventName: null, properties: null },
              content: {
                headline: 'H',
                body: 'B',
                imageUrl: null,
                backgroundColor: null,
                textColor: null,
                showCloseButton: true,
              },
            }),
            message({
              messageId: 'present',
              expiresAt: '2099-01-01T00:00:00.000Z',
              buttons: [
                {
                  buttonId: 'b1',
                  label: 'Go',
                  action: 'DISMISS',
                  style: 'PRIMARY',
                },
              ],
            }),
          ]),
        ),
      );

      await inapp.start(false);

      expect(inapp.snapshot().messages).toBe(3);
    });

    it('drops a layout web cannot render', async () => {
      stubFetch(
        respond(
          200,
          bundle([message({ layout: 'FULLSCREEN' }), message({ messageId: 'ok' })]),
        ),
      );

      await inapp.start(false);

      expect(inapp.snapshot().messages).toBe(1);
    });

    it('drops a custom-html message whose source carries no payload', async () => {
      // Not degraded to a bare headline panel: the author designed markup, and a stray text
      // modal in its place is worse than the message not appearing.
      stubFetch(
        respond(
          200,
          bundle([
            message({
              layout: 'CUSTOM_HTML',
              customHtml: { source: 'INLINE', url: 'https://a.test/x' },
            }),
          ]),
        ),
      );

      await inapp.start(false);

      expect(inapp.snapshot().messages).toBe(0);
    });

    it('keeps a custom-html message with usable markup', async () => {
      stubFetch(
        respond(
          200,
          bundle([
            message({
              layout: 'CUSTOM_HTML',
              customHtml: { source: 'INLINE', html: '<p>hi</p>' },
            }),
          ]),
        ),
      );

      await inapp.start(false);

      expect(inapp.snapshot().messages).toBe(1);
    });

    it('drops a message missing a required field', async () => {
      stubFetch(
        respond(200, bundle([message({ content: { body: 'no headline' } })])),
      );

      await inapp.start(false);

      expect(inapp.snapshot().messages).toBe(0);
    });
  });

  describe('display rules', () => {
    const withRules = (rules: Record<string, number>, extra = {}) =>
      message({
        displayRules: {
          maxPerSession: 5,
          maxLifetime: 5,
          minSecondsBetween: 0,
          delaySeconds: 0,
          ...rules,
        },
        ...extra,
      });

    it('takes the first survivor in server order, never a client re-sort', async () => {
      // The server already emits priority DESC, then earliest expiry, then
      // campaignId. A client-side sort could only diverge from that.
      stubFetch(
        respond(
          200,
          bundle([
            withRules({}, { messageId: 'first', priority: 1 }),
            withRules({}, { messageId: 'second', priority: 999 }),
          ]),
        ),
      );
      await inapp.start(false);

      const picked = inapp.pick(Date.now(), 'APP_OPEN', null, {});

      expect(picked?.messageId).toBe('first');
    });

    it('skips an expired message', async () => {
      stubFetch(
        respond(
          200,
          bundle([
            withRules({}, { expiresAt: '2020-01-01T00:00:00.000Z' }),
          ]),
        ),
      );
      await inapp.start(false);

      expect(inapp.pick(Date.now(), 'APP_OPEN', null, {})).toBeNull();
    });

    it('reports an expiry exactly once', async () => {
      stubFetch(
        respond(
          200,
          bundle([withRules({}, { expiresAt: '2020-01-01T00:00:00.000Z' })]),
        ),
      );
      await inapp.start(false);

      inapp.pick(Date.now(), 'APP_OPEN', null, {});
      inapp.pick(Date.now(), 'APP_OPEN', null, {});
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Asserted on the wire, not on queue residue: the beacon is flushed
      // immediately and the row is deleted the moment the POST succeeds.
      const posted = calls
        .filter((call) => call.url.includes('/in-app/events'))
        .flatMap((call) => {
          const body = JSON.parse(String(call.init.body)) as {
            events: { eventType: string }[];
          };
          return body.events;
        });
      expect(posted.filter((event) => event.eventType === 'expired')).toHaveLength(
        1,
      );
    });

    it('stops at maxLifetime', async () => {
      stubFetch(respond(200, bundle([withRules({ maxLifetime: 1 })])));
      await inapp.start(false);
      const first = inapp.pick(Date.now(), 'APP_OPEN', null, {});
      expect(first).not.toBeNull();

      await inapp.recordImpression(first!, null);

      expect(inapp.pick(Date.now(), 'APP_OPEN', null, {})).toBeNull();
    });

    it('stops at maxPerSession even when lifetime allows more', async () => {
      stubFetch(
        respond(200, bundle([withRules({ maxPerSession: 1, maxLifetime: 9 })])),
      );
      await inapp.start(false);
      const first = inapp.pick(Date.now(), 'APP_OPEN', null, {});
      await inapp.recordImpression(first!, null);

      expect(inapp.pick(Date.now(), 'APP_OPEN', null, {})).toBeNull();
    });

    it('honours the cooldown window', async () => {
      stubFetch(
        respond(
          200,
          bundle([
            withRules({ maxPerSession: 9, maxLifetime: 9, minSecondsBetween: 3600 }),
          ]),
        ),
      );
      await inapp.start(false);
      const first = inapp.pick(Date.now(), 'APP_OPEN', null, {});
      await inapp.recordImpression(first!, null);

      expect(inapp.pick(Date.now(), 'APP_OPEN', null, {})).toBeNull();
      // Past the cooldown it becomes eligible again.
      expect(
        inapp.pick(Date.now() + 3_600_001, 'APP_OPEN', null, {}),
      ).not.toBeNull();
    });

    it('does not collapse SCREEN_VIEW and CUSTOM_EVENT', async () => {
      stubFetch(
        respond(
          200,
          bundle([
            message({
              trigger: { type: 'SCREEN_VIEW', eventName: 'cart' },
            }),
          ]),
        ),
      );
      await inapp.start(false);

      expect(inapp.pick(Date.now(), 'CUSTOM_EVENT', 'cart', {})).toBeNull();
      expect(inapp.pick(Date.now(), 'SCREEN_VIEW', 'cart', {})).not.toBeNull();
    });

    it('matches trigger properties by coerced equality', async () => {
      stubFetch(
        respond(
          200,
          bundle([
            message({
              trigger: {
                type: 'CUSTOM_EVENT',
                eventName: 'buy',
                properties: { tier: 'gold', count: 2 },
              },
            }),
          ]),
        ),
      );
      await inapp.start(false);

      // Non-string values are tolerated: the backend validates properties only
      // with @IsObject(), so the wire can carry anything JSON can express.
      expect(
        inapp.pick(Date.now(), 'CUSTOM_EVENT', 'buy', { tier: 'gold', count: '2' }),
      ).not.toBeNull();
      expect(
        inapp.pick(Date.now(), 'CUSTOM_EVENT', 'buy', { tier: 'silver', count: 2 }),
      ).toBeNull();
    });

    it('shows nothing while suppressed', async () => {
      stubFetch(respond(200, bundle([message()])));
      await inapp.start(false);
      inapp.setSuppressed(true);

      expect(inapp.pick(Date.now(), 'APP_OPEN', null, {})).toBeNull();
    });

    it('drops a trigger arriving while a message is on screen', async () => {
      stubFetch(respond(200, bundle([message({ messageId: 'a' })])));
      await inapp.start(false);
      inapp.setRenderer(() => {});

      inapp.observe('APP_OPEN', null, {});

      // Dropped, not queued: a queued message surfaces seconds after the
      // interaction that supposedly caused it, attributed to the wrong action.
      expect(inapp.pick(Date.now(), 'APP_OPEN', null, {})).toBeNull();
    });
  });

  describe('beacons', () => {
    it('uses the four lowercase eventType values verbatim', async () => {
      stubFetch(respond(200, bundle([message()])));
      await inapp.start(false);
      const target = inapp.pick(Date.now(), 'APP_OPEN', null, {})!;

      await inapp.recordImpression(target, 'cart');
      await inapp.recordClick(target, 'cta');
      await inapp.recordDismiss(target, 4);

      const bodies = (await allEvents(QUEUE.inAppBeacons)).map(
        (row) => JSON.parse(row.body) as Record<string, unknown>,
      );
      const types = bodies.map((body) => body.eventType);
      // Uppercase 400s the ENTIRE batch under @IsEnum + forbidNonWhitelisted.
      expect(types).toContain('impression');
      expect(types).toContain('clicked');
      expect(types).toContain('dismissed');
    });

    it('sends no property the endpoint does not declare', async () => {
      stubFetch(respond(200, bundle([message()])));
      await inapp.start(false);
      const target = inapp.pick(Date.now(), 'APP_OPEN', null, {})!;

      await inapp.recordClick(target, 'cta');

      const allowed = new Set([
        'messageId',
        'campaignId',
        'eventType',
        'timestamp',
        'buttonId',
        'triggerEventName',
        'visibleSeconds',
        'variantKey',
      ]);
      const body = JSON.parse(
        (await allEvents(QUEUE.inAppBeacons))[0].body,
      ) as Record<string, unknown>;
      // One extra key is a 400 for the whole batch — there is no per-endpoint
      // whitelist override on this route.
      for (const key of Object.keys(body)) expect(allowed.has(key)).toBe(true);
    });

    it('clamps visibleSeconds into the accepted range', async () => {
      stubFetch(respond(200, bundle([message()])));
      await inapp.start(false);
      const target = inapp.pick(Date.now(), 'APP_OPEN', null, {})!;

      await inapp.recordDismiss(target, 999_999);

      const body = JSON.parse(
        (await allEvents(QUEUE.inAppBeacons))[0].body,
      ) as Record<string, number>;
      expect(body.visibleSeconds).toBe(86_400);
    });

    it('queues beacons in their own store, away from analytics events', async () => {
      stubFetch(respond(200, bundle([message()])));
      await inapp.start(false);
      const target = inapp.pick(Date.now(), 'APP_OPEN', null, {})!;
      await inapp.recordClick(target, 'cta');

      // The events drain stops at the first retryable failure to preserve
      // order; sharing that queue would let one stuck beacon wedge analytics.
      expect((await allEvents(QUEUE.inAppBeacons)).length).toBeGreaterThan(0);
      expect(await allEvents(QUEUE.events)).toHaveLength(0);
    });
  });

  describe('audience invalidation', () => {
    it('drops the cached bundle when the identity changes', async () => {
      stubFetch(respond(200, bundle([message()])));
      await inapp.start(false);
      expect(inapp.snapshot().messages).toBe(1);

      stubFetch(respond(200, bundle([], 'v2')));
      await inapp.invalidateAudience();

      // Serving the previous person's bundle to a newly identified contact
      // shows them somebody else's message.
      expect(await get(KEYS.inAppBundle)).not.toBeNull();
      expect(inapp.snapshot().messages).toBe(0);
    });
  });
});
