import { beforeEach, describe, expect, it, vi } from 'vitest';

type IndexModule = typeof import('../src/index');
type StoreModule = typeof import('../src/store');

let sdk: IndexModule;
let store: StoreModule;

function stubPage(visibilityState = 'visible', prerendering = false) {
  vi.stubGlobal('document', {
    visibilityState,
    prerendering,
    addEventListener: vi.fn(),
  });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
}

async function queuedNames(): Promise<string[]> {
  return (await store.allEvents(store.QUEUE.events)).map(
    (e) => JSON.parse(e.body).event as string,
  );
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.resetModules(); // index.ts holds `ready` and the pre-init buffer in module state
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  stubPage();
  store = await import('../src/store');
  sdk = await import('../src/index');
  for (const e of await store.allEvents(store.QUEUE.events)) {
    if (e.id !== undefined) await store.removeEvent(store.QUEUE.events, e.id);
  }
  await store.set(store.KEYS.sessionStartedAt, 0);
  await store.set(store.KEYS.backgroundedAt, 0);
  await store.set(store.KEYS.externalId, null);
  await store.set(store.KEYS.email, null);
  await store.set(store.KEYS.phoneNumber, null);
});

describe('init() validation', () => {
  it('accepts plain http for localhost, for a local backend', async () => {
    await expect(
      sdk.init({ clientKey: 'pub_x', baseUrl: 'http://localhost:8076' }),
    ).resolves.toBeUndefined();
  });

  it('rejects http anywhere else', async () => {
    await expect(
      sdk.init({ clientKey: 'pub_x', baseUrl: 'http://api.example.com' }),
    ).rejects.toThrow(/HTTPS/);
  });
});

describe('pre-init buffering', () => {
  it('buffers track() calls made before init() and enqueues them on init', async () => {
    await sdk.track('early.event', { n: 1 });
    expect(await queuedNames()).toEqual([]); // nothing durable yet

    await sdk.init({ clientKey: 'pub_x', baseUrl: 'https://api.example.com' });

    // Buffered events land first, then the session opens.
    expect(await queuedNames()).toEqual(['early.event', 'arsel.session_start']);
  });

  it('bounds the buffer instead of growing without limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 120; i += 1) await sdk.track(`e${i}`);

    await sdk.init({ clientKey: 'pub_x', baseUrl: 'https://api.example.com' });

    const names = await queuedNames();
    expect(names.filter((n) => n.startsWith('e'))).toHaveLength(100);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('before init()'));
    warn.mockRestore();
  });
});

describe('session gating', () => {
  it('does not open a session for a hidden tab', async () => {
    stubPage('hidden');

    await sdk.init({ clientKey: 'pub_x', baseUrl: 'https://api.example.com' });

    expect(await queuedNames()).not.toContain('arsel.session_start');
  });

  it('does not open a session for a prerendered page never seen', async () => {
    stubPage('visible', true);

    await sdk.init({ clientKey: 'pub_x', baseUrl: 'https://api.example.com' });

    expect(await queuedNames()).not.toContain('arsel.session_start');
  });

  it('opens a session for a visible page', async () => {
    await sdk.init({ clientKey: 'pub_x', baseUrl: 'https://api.example.com' });

    expect(await queuedNames()).toContain('arsel.session_start');
  });
});

describe('identify() validation', () => {
  beforeEach(async () => {
    await sdk.init({ clientKey: 'pub_x', baseUrl: 'https://api.example.com' });
  });

  it('rejects a non-E.164 phone number instead of poisoning every later event', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sdk.identify({ phoneNumber: '0501234567' });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('E.164'));
    expect(await store.get(store.KEYS.phoneNumber)).toBeNull();
    expect(await queuedNames()).not.toContain('arsel.identify');
    error.mockRestore();
  });

  it('rejects a malformed email', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sdk.identify({ email: 'not-an-email' });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('email'));
    expect(await store.get(store.KEYS.email)).toBeNull();
    error.mockRestore();
  });

  it('keeps the valid identifiers when one of several is invalid', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sdk.identify({ externalId: 'u_1', phoneNumber: 'garbage' });

    expect(await store.get(store.KEYS.externalId)).toBe('u_1');
    expect(await store.get(store.KEYS.phoneNumber)).toBeNull();
    expect(await queuedNames()).toContain('arsel.identify');
    error.mockRestore();
  });

  it('accepts a valid E.164 number and a valid email', async () => {
    await sdk.identify({ email: 'sara@example.com', phoneNumber: '+966501234567' });

    expect(await store.get(store.KEYS.email)).toBe('sara@example.com');
    expect(await store.get(store.KEYS.phoneNumber)).toBe('+966501234567');
  });
});

describe('flush triggers', () => {
  it('flushes when the browser comes back online and when the tab becomes visible', async () => {
    await sdk.init({ clientKey: 'pub_x', baseUrl: 'https://api.example.com' });

    const win = window as unknown as { addEventListener: ReturnType<typeof vi.fn> };
    const doc = document as unknown as { addEventListener: ReturnType<typeof vi.fn> };
    const events = [
      ...win.addEventListener.mock.calls.map((c: unknown[]) => c[0]),
      ...doc.addEventListener.mock.calls.map((c: unknown[]) => c[0]),
    ];
    expect(events).toContain('online');
    expect(events).toContain('visibilitychange');
  });
});
