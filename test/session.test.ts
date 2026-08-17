import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_SESSION_END, EVENT_SESSION_START } from '../src/events';
import { SESSION_GAP_MS, onHidden, onVisible } from '../src/session';
import { KEYS, allEvents, removeEvent, set } from '../src/store';

const START = 1_786_104_000_000;

async function names(): Promise<string[]> {
  return (await allEvents()).map((e) => JSON.parse(e.body).event as string);
}

async function bodies(): Promise<Record<string, unknown>[]> {
  return (await allEvents()).map(
    (e) => JSON.parse(e.body) as Record<string, unknown>,
  );
}

describe('sessions', () => {
  beforeEach(async () => {
    // Never actually send: these assert on what was queued.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    for (const e of await allEvents()) {
      if (e.id !== undefined) await removeEvent(e.id);
    }
    await set(KEYS.sessionStartedAt, 0);
    await set(KEYS.backgroundedAt, 0);
    await set(KEYS.clientKey, null);
  });

  it('uses the industry-standard 30-minute gap, not seconds', () => {
    // 30s would read every tab switch as a session boundary and double ingest.
    expect(SESSION_GAP_MS).toBe(30 * 60 * 1000);
  });

  it('first visible opens a session', async () => {
    await onVisible(START);

    expect(await names()).toEqual([EVENT_SESSION_START]);
  });

  it('a brief tab switch resumes the same session', async () => {
    await onVisible(START);
    await onHidden(START + 1_000);
    await onVisible(START + 1_000 + SESSION_GAP_MS - 1);

    expect(await names()).toEqual([EVENT_SESSION_START]);
  });

  it('a long absence ends the old session and starts a new one', async () => {
    await onVisible(START);
    await onHidden(START + 1_000);
    await onVisible(START + 1_000 + SESSION_GAP_MS + 1);

    expect(await names()).toEqual([
      EVENT_SESSION_START,
      EVENT_SESSION_END,
      EVENT_SESSION_START,
    ]);
  });

  it('backdates the end to when the page actually went away', async () => {
    // Not to when we noticed. Someone returning the next morning would
    // otherwise record a session that ran all night.
    const hiddenAt = START + 60_000;
    await onVisible(START);
    await onHidden(hiddenAt);
    await onVisible(hiddenAt + 8 * 60 * 60 * 1000);

    const end = (await bodies()).find((b) => b.event === EVENT_SESSION_END)!;
    expect(end.timestamp).toBe(new Date(hiddenAt).toISOString());
    expect((end.data as Record<string, number>).duration_seconds).toBe(60);
  });

  it('hiding without an open session emits nothing', async () => {
    await onHidden(START);

    expect(await names()).toEqual([]);
  });
});
