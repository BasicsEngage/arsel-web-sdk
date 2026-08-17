import 'fake-indexeddb/auto';

// The SDK mints ids with crypto.randomUUID; Node has it on webcrypto.
if (!globalThis.crypto?.randomUUID) {
  const { webcrypto } = await import('node:crypto');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}
