import { EVENT_SESSION_END, EVENT_SESSION_START, enqueue } from './events';
import { KEYS, get, set } from './store';

/**
 * A session ends after this long away — the industry-standard 30 minutes.
 * Shorter gaps read a tab switch or a phone unlocking as a session boundary
 * and inflate every count.
 */
export const SESSION_GAP_MS = 30 * 60_000;

/**
 * Sessions from visibility transitions, with no timers.
 *
 * A session ends after {@link SESSION_GAP_MS} hidden, but that is only
 * *discovered* on the next visible — so the end event is emitted then,
 * backdated to when the page actually went away. A timer would have to survive
 * the tab being frozen or discarded, which is precisely when it matters.
 *
 * The consequence is the standard one: someone who closes the tab and never
 * returns produces no `session_end`. An open-but-unclosed session beats a
 * fabricated end time.
 */
export async function onVisible(now = Date.now()): Promise<void> {
  const openedAt = (await get<number>(KEYS.sessionStartedAt)) ?? 0;
  const hiddenAt = (await get<number>(KEYS.backgroundedAt)) ?? 0;

  if (openedAt !== 0) {
    if (hiddenAt === 0 || now - hiddenAt < SESSION_GAP_MS) return;
    await enqueue(
      EVENT_SESSION_END,
      { duration_seconds: Math.round((hiddenAt - openedAt) / 1000) },
      hiddenAt,
    );
  }

  await set(KEYS.sessionStartedAt, now);
  await set(KEYS.backgroundedAt, 0);
  await enqueue(EVENT_SESSION_START, {}, now);
}

export async function onHidden(now = Date.now()): Promise<void> {
  // Recorded, not emitted: whether this is the end of a session or a two-second
  // tab switch is not knowable yet.
  if (((await get<number>(KEYS.sessionStartedAt)) ?? 0) === 0) return;
  await set(KEYS.backgroundedAt, now);
}

export function attach(): void {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    void (document.visibilityState === 'visible' ? onVisible() : onHidden());
  });
  // `visibilitychange` does not fire on a real close, and `unload` is not
  // reliable on mobile. `pagehide` is the one the browser actually guarantees.
  window.addEventListener('pagehide', () => void onHidden());
}
