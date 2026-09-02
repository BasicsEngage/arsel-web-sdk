import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_APP_INSTALLED } from '../src/events';
import { hasDeviceIdentity, reportInstall } from '../src/install';
import { KEYS, QUEUE, allEvents, removeEvent, set } from '../src/store';
import { SDK_VERSION } from '../src/version';

async function names(): Promise<string[]> {
  return (await allEvents(QUEUE.events)).map((e) => JSON.parse(e.body).event as string);
}

async function data(): Promise<Record<string, unknown>> {
  const [only] = await allEvents(QUEUE.events);
  return JSON.parse(only.body).data as Record<string, unknown>;
}

/** Both failure modes are permanent: a duplicate, and the upgrade that bills every visitor. */
describe('install reporting', () => {
  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    for (const e of await allEvents(QUEUE.events)) {
      if (e.id !== undefined) await removeEvent(QUEUE.events, e.id);
    }
    await set(KEYS.installReported, null);
    await set(KEYS.anonymousId, null);
    await set(KEYS.installationId, null);
    await set(KEYS.clientKey, null);
  });

  it('emits app_installed on a first visit', async () => {
    await reportInstall(false);

    expect(await names()).toEqual([EVENT_APP_INSTALLED]);
  });

  it('carries the sdk version and platform', async () => {
    await reportInstall(false);

    expect(await data()).toMatchObject({ sdk_version: SDK_VERSION, platform: 'web' });
  });

  it('emits nothing on a later load', async () => {
    await reportInstall(false);
    for (const e of await allEvents(QUEUE.events)) {
      if (e.id !== undefined) await removeEvent(QUEUE.events, e.id);
    }

    await reportInstall(false);

    expect(await names()).toEqual([]);
  });

  it('seeds a browser that predates the sdk without emitting', async () => {
    await reportInstall(true);

    expect(await names()).toEqual([]);
  });

  it('keeps a seeded browser silent on every later load', async () => {
    await reportInstall(true);
    await reportInstall(false);

    expect(await names()).toEqual([]);
  });

  describe('hasDeviceIdentity', () => {
    it('is false for a browser the sdk has never run in', async () => {
      expect(await hasDeviceIdentity()).toBe(false);
    });

    it('is true once an anonymous id exists', async () => {
      await set(KEYS.anonymousId, 'anon-1');

      expect(await hasDeviceIdentity()).toBe(true);
    });

    it('is true for a browser that only ever registered for push', async () => {
      await set(KEYS.installationId, 'install-1');

      expect(await hasDeviceIdentity()).toBe(true);
    });
  });
});
