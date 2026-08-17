/** Public configuration for {@link init}. */
export interface ArselConfig {
  /**
   * The org's publishable `pub_…` key. Page-readable by design: it authenticates
   * the events API and the push API, and grants nothing a secret API key does.
   */
  clientKey: string;

  /**
   * Arsel API base, e.g. `https://api.arsel.sa`. HTTPS enforced, except
   * `http://localhost` / `http://127.0.0.1` for a local backend.
   */
  baseUrl: string;

  /**
   * Path to the service worker stub, e.g. `/arsel-sw.js`. **Required for
   * push** — without it (and without `serviceWorker: 'external'`) the SDK
   * registers nothing and only the events API runs. Scope is a browser rule:
   * a worker at `/js/sw.js` can only control `/js/`, so serve it from the
   * root of the area you want push on.
   */
  serviceWorkerPath?: string;

  /**
   * `'external'` when your own service worker `importScripts` arsel-sw.js
   * (e.g. a PWA that already has a worker on this scope). The SDK then
   * registers nothing and uses the worker controlling the page.
   */
  serviceWorker?: 'external';

  /** Emit SDK diagnostics to the console. Off by default. */
  debug?: boolean;
}

/** Identifiers accepted by {@link identify}. Supply whichever you hold. */
export interface ArselIdentity {
  /**
   * Your own id for this person. The documented default: it binds a contact
   * without putting an email address in page script, and it survives the user
   * changing their address.
   */
  externalId?: string;
  email?: string;
  phoneNumber?: string;
}

export type EventProperties = Record<string, unknown>;

/** What the org's web push API is configured with. Served unauthenticated. */
export interface WebPushConfig {
  vapidPublicKey: string;
  /**
   * Bumped when the org rotates its VAPID keypair. A subscription created
   * against an older version is dead — the SDK re-subscribes rather than
   * leaving the user quietly unreachable.
   */
  keyVersion: number;
}

/** A point-in-time snapshot for support tickets. Contains no secrets. */
export interface ArselDiagnostics {
  sdkVersion: string;
  initialized: boolean;
  anonymousId: string | null;
  hasAssertedIdentity: boolean;
  installationId: string | null;
  hasDeviceSecret: boolean;
  /** Events persisted but not yet delivered. A number that only grows is the tell. */
  pendingEvents: number;
  permission: NotificationPermission | 'unsupported';
  isSubscribed: boolean;
  vapidKeyVersion: number | null;
  lastResponseCode: number | null;
  lastResponsePath: string | null;
  lastResponseAtMs: number | null;
}
