import { EVENT_APP_INSTALLED, enqueue } from './events';
import { KEYS, get, set } from './store';
import { SDK_VERSION } from './version';

/**
 * Emits `arsel.app_installed` once per browser profile.
 *
 * A browser has no install step, so this means "the first time we ever saw this
 * device". Clearing site data resets the store and re-fires it; web install
 * counts run high by that much, and a page cannot do better.
 */
export async function reportInstall(alreadyInstalled: boolean): Promise<void> {
  if (await get<boolean>(KEYS.installReported)) return;

  // Before the emit, not after: a tab closed in between costs one install
  // event, where the other order costs a duplicate on every load until one lands.
  await set(KEYS.installReported, true);
  if (alreadyInstalled) return;

  await enqueue(EVENT_APP_INSTALLED, {
    sdk_version: SDK_VERSION,
    platform: 'web',
  });
}

/** Must be read before `anonymousId()` mints one, or every visit looks new. */
export async function hasDeviceIdentity(): Promise<boolean> {
  const [anon, installation] = await Promise.all([
    get<string>(KEYS.anonymousId),
    get<string>(KEYS.installationId),
  ]);
  return Boolean(anon) || Boolean(installation);
}
