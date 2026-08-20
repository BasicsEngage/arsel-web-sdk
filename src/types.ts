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

  /**
   * In-app messaging. `true` (the default) registers this browser for in-app
   * messages — which needs no notification permission and shows no prompt —
   * and renders them. Pass `false` to disable, or an object to tune the layer.
   */
  inApp?: boolean | InAppOptions;
}

export interface InAppOptions {
  /**
   * Stacking context for the message host. Default 2147483000 — deliberately
   * below the maximum, so a host site's own top-most modal still wins.
   */
  zIndex?: number;
  /** Accessible label for the close control. Default `'Close'`. */
  closeLabel?: string;
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
  /**
   * Why the SDK refused to start, or null. Set when init() was given an invalid
   * configuration: nothing is collected and no call has any effect until it is
   * fixed. Same field, same rules, on all three Arsel SDKs.
   */
  configError: string | null;
  anonymousId: string | null;
  hasAssertedIdentity: boolean;
  installationId: string | null;
  hasDeviceSecret: boolean;
  /** Events persisted but not yet delivered. A number that only grows is the tell. */
  pendingEvents: number;
  permission: NotificationPermission | 'unsupported';
  isSubscribed: boolean;
  /**
   * The backend's last reported `status` for this device, e.g. `REVOKED` after a
   * durable opt-out. Named as on the Android SDK. Null before the first register.
   */
  subscriptionStatus: string | null;
  vapidKeyVersion: number | null;
  lastResponseCode: number | null;
  lastResponsePath: string | null;
  lastResponseAtMs: number | null;
  /** Messages currently cached for this device. */
  inAppMessages: number;
  inAppBundleVersion: string | null;
  inAppFetchedAtMs: number | null;
  /** Beacons persisted but not yet delivered. A number that only grows is the tell. */
  pendingInAppBeacons: number;
}
