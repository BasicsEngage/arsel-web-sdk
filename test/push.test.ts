import { beforeEach, describe, expect, it, vi } from 'vitest';

const BASE_URL = 'https://api.example.com';
const CLIENT_KEY = 'pub_test';
const VAPID = 'AQIDBA'; // base64url for bytes [1,2,3,4]

type PushModule = typeof import('../src/push');
type StoreModule = typeof import('../src/store');

let push: PushModule;
let store: StoreModule;

function fakeSubscription() {
  return {
    toJSON: () => ({
      endpoint: 'https://push.example/ep-1',
      keys: { p256dh: 'p256', auth: 'auth-secret' },
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

function fakeRegistration(overrides: Record<string, unknown> = {}) {
  return {
    active: { state: 'activated' },
    installing: null,
    waiting: null,
    pushManager: {
      subscribe: vi.fn().mockResolvedValue(fakeSubscription()),
      getSubscription: vi.fn().mockResolvedValue(null),
    },
    addEventListener: vi.fn(),
    ...overrides,
  };
}

function stubBrowser(registerImpl: (path: string) => Promise<unknown>) {
  const register = vi.fn(registerImpl);
  vi.stubGlobal('navigator', {
    language: 'en-US',
    serviceWorker: {
      register,
      getRegistration: vi.fn().mockResolvedValue(undefined),
      ready: new Promise(() => {}), // never settles — .ready must never be relied on
    },
  });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', { permission: 'granted' });
  return register;
}

function stubApi(subscriptionStatus = 200, registerBody: Record<string, unknown> = { deviceSecret: 'ds-1' }) {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    if (url.includes('/push/web/config')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ vapidPublicKey: VAPID, subject: 's', keyVersion: 1 }),
      };
    }
    return {
      ok: subscriptionStatus < 300,
      status: subscriptionStatus,
      json: async () => registerBody,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.resetModules(); // push.ts holds registration mode in module state
  store = await import('../src/store');
  push = await import('../src/push');
  await store.set(store.KEYS.clientKey, CLIENT_KEY);
  await store.set(store.KEYS.baseUrl, BASE_URL);
  await store.set(store.KEYS.installationId, null);
  await store.set(store.KEYS.deviceSecret, null);
  await store.set(store.KEYS.subscriptionStatus, null);
});

describe('register', () => {
  it('registers without forcing a scope, so subpath workers do not throw', async () => {
    const registration = fakeRegistration();
    const register = stubBrowser(async () => registration);

    await push.register('/static/arsel-sw.js');

    expect(register).toHaveBeenCalledTimes(1);
    // No { scope: '/' } second argument — the default scope is the path's
    // directory, and forcing root throws SecurityError for subpath workers.
    expect(register.mock.calls[0]).toEqual(['/static/arsel-sw.js']);
  });
});

describe('preflight', () => {
  it('reports unconfigured push instead of hanging', async () => {
    stubBrowser(async () => fakeRegistration());

    const problem = await push.preflight(50);

    expect(problem).toContain('push is not configured');
  });

  it('fails fast with the registration error when register() rejected', async () => {
    stubBrowser(async () => {
      throw new Error('SecurityError: bad MIME type');
    });

    await push.register('/arsel-sw.js');
    const problem = await push.preflight(50);

    expect(problem).toContain("registration failed for '/arsel-sw.js'");
    expect(problem).toContain('bad MIME type');
  });

  it('times out with an actionable message when the worker never activates', async () => {
    const stuck = fakeRegistration({
      active: null,
      installing: { state: 'installing', addEventListener: vi.fn() },
    });
    stubBrowser(async () => stuck);

    await push.register('/arsel-sw.js');
    const problem = await push.preflight(50);

    expect(problem).toContain('did not activate within 50ms');
  });

  it('passes when the registration has an active worker', async () => {
    stubBrowser(async () => fakeRegistration());

    await push.register('/arsel-sw.js');

    expect(await push.preflight(50)).toBeNull();
  });
});

describe('subscribe', () => {
  it('posts subscription.toJSON() verbatim, with the anonymous id', async () => {
    stubBrowser(async () => fakeRegistration());
    const calls = stubApi();

    await push.register('/arsel-sw.js');
    expect(await push.subscribe()).toBe(true);

    const registerCall = calls.find((c) => c.url.endsWith('/push/subscriptions'))!;
    const body = JSON.parse(registerCall.options!.body as string);
    expect(body.endpoint).toBe('https://push.example/ep-1');
    expect(body.keys).toEqual({ p256dh: 'p256', auth: 'auth-secret' });
    expect(body.platform).toBe('web');
    // Binds the subscription to the same identity the events API sends.
    expect(body.anonymousId).toBe(await store.anonymousId());
    expect(await store.get(store.KEYS.deviceSecret)).toBe('ds-1');
  });

  it('returns false when the browser cannot reach its push service', async () => {
    // The most common real-world subscribe() failure: firewalled push service,
    // captive portal, or a Chromium build with no push support at all.
    const registration = fakeRegistration();
    registration.pushManager.subscribe = vi
      .fn()
      .mockRejectedValue(
        new DOMException('Registration failed - push service error', 'AbortError'),
      );
    stubBrowser(async () => registration);
    stubApi();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await push.register('/arsel-sw.js');
    await expect(push.subscribe()).resolves.toBe(false);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('push service error'));
    error.mockRestore();
  });

  it('returns false fast when registration failed, instead of hanging on .ready', async () => {
    stubBrowser(async () => {
      throw new Error('404');
    });
    stubApi();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await push.register('/arsel-sw.js');
    expect(await push.subscribe()).toBe(false);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('registration failed'));
    error.mockRestore();
  });

  // A durable opt-out answers the register call with 200 and leaves the row
  // REVOKED — registering is deliberately not a way to undo one. Reading only
  // the HTTP status made the SDK report that device as subscribed, so an app
  // would show "notifications on" to someone who can never receive another push.
  it('reports failure when the backend kept the device revoked', async () => {
    stubBrowser(async () => fakeRegistration());
    stubApi(200, { deviceSecret: 'ds-1', status: 'REVOKED' });

    await push.register('/arsel-sw.js');

    expect(await push.subscribe()).toBe(false);
    expect(await store.get(store.KEYS.subscriptionStatus)).toBe('REVOKED');
  });

  it('reports success when the backend accepted the device', async () => {
    stubBrowser(async () => fakeRegistration());
    stubApi(200, { deviceSecret: 'ds-1', status: 'ACTIVE' });

    await push.register('/arsel-sw.js');

    expect(await push.subscribe()).toBe(true);
    expect(await store.get(store.KEYS.subscriptionStatus)).toBe('ACTIVE');
  });
});

describe('isSubscribed', () => {
  // The browser keeps its PushSubscription across an opt-out, so asking it
  // alone always answers yes for a device the backend will never send to.
  it('is false for a revoked device even though the browser still holds one', async () => {
    const registration = fakeRegistration({
      pushManager: {
        subscribe: vi.fn(),
        getSubscription: vi.fn().mockResolvedValue(fakeSubscription()),
      },
    });
    stubBrowser(async () => registration);
    vi.stubGlobal('navigator', {
      language: 'en-US',
      serviceWorker: {
        register: vi.fn(),
        getRegistration: vi.fn().mockResolvedValue(registration),
        ready: new Promise(() => {}),
      },
    });
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('Notification', { permission: 'granted' });

    expect(await push.isSubscribed()).toBe(true);

    await store.set(store.KEYS.subscriptionStatus, 'REVOKED');
    expect(await push.isSubscribed()).toBe(false);
  });
});

describe('reconcile', () => {
  it('never rejects when subscribe() fails, because init() cannot catch it', async () => {
    const registration = fakeRegistration();
    registration.pushManager.subscribe = vi
      .fn()
      .mockRejectedValue(
        new DOMException('Registration failed - push service error', 'AbortError'),
      );
    stubBrowser(async () => registration);
    stubApi();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await push.register('/arsel-sw.js');
    await expect(push.reconcile()).resolves.toBeUndefined();

    error.mockRestore();
  });
});

describe('optOut', () => {
  it('revokes server-side with device auth', async () => {
    stubBrowser(async () => fakeRegistration());
    const calls = stubApi();
    await store.set(store.KEYS.installationId, 'inst-1');
    await store.set(store.KEYS.deviceSecret, 'ds-1');

    expect(await push.optOut()).toBe(true);

    const call = calls.find((c) => c.url.endsWith('/push/subscriptions/unsubscribe'))!;
    expect(call).toBeTruthy();
    const headers = (call.options!.headers ?? {}) as Record<string, string>;
    expect(headers['X-Arsel-Device-Auth']).toBe('ds-1');
    expect(JSON.parse(call.options!.body as string)).toEqual({
      installationId: 'inst-1',
    });
  });

  it('is a no-op false when this browser never completed a registration', async () => {
    stubBrowser(async () => fakeRegistration());
    const calls = stubApi();

    expect(await push.optOut()).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
