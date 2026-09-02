import {
  KEYS,
  QUEUE,
  addEvent,
  allEvents,
  countEvents,
  get,
  remove,
  removeEvent,
  set,
  trimQueue,
} from './store';
import { RESULT, getJson, post } from './transport';
import type { EventProperties, InAppOptions } from './types';

/**
 * In-app messaging: fetch the eligibility bundle, match triggers locally,
 * enforce the frequency rules, and report what was shown.
 *
 * The division of labour is the whole design. The server answers *which*
 * messages this device may show — resolving audience, consent, campaign window,
 * grants and lifetime caps, none of which a browser can know — and this module
 * answers *when*, so drawing a message costs no network round-trip.
 *
 * Nothing here touches the DOM; `inapp-view.ts` is the only module that does.
 */

const MS_PER_SECOND = 1000;
const STATE_TTL_MS = 30 * 24 * 60 * 60 * MS_PER_SECOND;
const MAX_QUEUED_BEACONS = 500;
const BEACON_BATCH_MAX = 50;
const MAX_VISIBLE_SECONDS = 86_400;
const DEFAULT_TTL_SECONDS = 900;

const DEFAULT_RULES = {
  maxPerSession: 1,
  maxLifetime: 3,
  minSecondsBetween: 86_400,
  delaySeconds: 0,
};

/**
 * Layouts this build can draw. FULLSCREEN is absent because it is filtered
 * server-side for web and never renderable here.
 *
 * This list is the client half of the server's `IN_APP_SUPPORTED_LAYOUTS`, and
 * the two have to be extended together: the server gates on the SDK version it
 * is told, but a build that receives a layout missing from this list drops the
 * message with only a debug line to show for it.
 */
const WEB_LAYOUTS: readonly string[] = [
  'MODAL',
  'BANNER_TOP',
  'BANNER_BOTTOM',
  'IMAGE_ONLY',
  'HALF_INTERSTITIAL',
  'ALERT',
  'FORM',
  'RATING',
];

let started = false;
let bundle: CachedBundle | null = null;
let state: Record<string, MessageState> = {};
let session: SessionCounts = { startedAt: 0, counts: {} };
let active: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let suppressed = false;
let refreshPromise: Promise<void> | null = null;
let renderer: ((message: InAppMessage) => void) | null = null;
let debug = false;
/**
 * Set once a request WITHOUT `If-None-Match` has succeeded, so a later failure
 * carrying it is attributable to the header rather than to being offline.
 */
let unconditionalHasWorked = false;

function log(message: string): void {
  if (debug) console.info(`[arsel] in-app: ${message}`);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function start(debugEnabled: boolean): Promise<void> {
  started = true;
  debug = debugEnabled;
  const [cached, savedState, savedSession] = await Promise.all([
    get<CachedBundle>(KEYS.inAppBundle),
    get<Record<string, MessageState>>(KEYS.inAppState),
    get<SessionCounts>(KEYS.inAppSession),
  ]);
  bundle = cached;
  state = savedState ?? {};
  session = savedSession ?? { startedAt: 0, counts: {} };
  await syncSessionWindow();
  await refresh();
}

export function setRenderer(fn: (message: InAppMessage) => void): void {
  renderer = fn;
}

/** Host asked to hold messages back — e.g. during checkout. Not persisted. */
export function setSuppressed(value: boolean): void {
  suppressed = value;
  if (value) cancelPending();
}

export function snapshot(): {
  messages: number;
  bundleVersion: string | null;
  fetchedAtMs: number | null;
} {
  return {
    messages: bundle?.messages.length ?? 0,
    bundleVersion: bundle?.bundleVersion ?? null,
    fetchedAtMs: bundle?.fetchedAtMs ?? null,
  };
}

export function pendingBeaconCount(): Promise<number> {
  return countEvents(QUEUE.inAppBeacons);
}

/**
 * The person this browser belongs to changed, so the cached bundle describes
 * the wrong audience. Dropped rather than refreshed in place: serving a stale
 * bundle to a newly identified contact shows them another person's message.
 */
export async function invalidateAudience(): Promise<void> {
  bundle = null;
  await remove(KEYS.inAppBundle);
  if (started) await refresh(true);
}

/** Reserved `arsel_iam_sync` push. Inert-but-ready: nothing emits it yet. */
export function handleSyncPing(): void {
  void refresh(true);
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

export function refresh(force = false): Promise<void> {
  // Single-flight. `GET /bundle` is throttled per ORG but not per device — the
  // throttle guard reads installationId from the request body and the bundle
  // carries it in the query — so one browser refetching in a loop can 429 every
  // other device in the org. This and the TTL gate are load-bearing.
  refreshPromise ??= runRefresh(force).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function runRefresh(force: boolean): Promise<void> {
  if (!started) return;
  const now = Date.now();
  if (
    !force &&
    bundle &&
    now - bundle.fetchedAtMs < bundle.ttlSeconds * MS_PER_SECOND
  ) {
    return;
  }

  const auth = await readAuth();
  // No secret means registration never completed. Silent by design: an org that
  // has not provisioned push at all is ordinary onboarding, not an error.
  if (!auth) return;

  const path = bundlePath(auth.clientKey, auth.installationId);
  const headers: Record<string, string> = {
    'X-Arsel-Device-Auth': auth.deviceSecret,
  };
  const conditional = Boolean(bundle?.bundleVersion);
  if (conditional) headers['If-None-Match'] = `"${bundle?.bundleVersion ?? ''}"`;

  let response = await fetchBundle(auth.baseUrl, path, headers);

  // A refused preflight and being offline are indistinguishable — both throw
  // before a status line. If the conditional request is the only thing that has
  // ever failed, a missing `If-None-Match` in the server's CORS allowlist is the
  // likelier cause, so retry once without it rather than going dark.
  if (response.code === CODE_OFFLINE && conditional && unconditionalHasWorked) {
    log('conditional request failed; retrying without If-None-Match');
    delete headers['If-None-Match'];
    response = await fetchBundle(auth.baseUrl, path, headers);
  }

  // Checked BEFORE the result: classify() maps 304 to `permanent`, which would
  // discard the cache on every successful revalidation.
  if (response.code === NOT_MODIFIED) {
    if (bundle) {
      bundle = { ...bundle, fetchedAtMs: now };
      await set(KEYS.inAppBundle, bundle);
    }
    return;
  }

  if (response.result !== RESULT.success || !response.body) {
    // `reauth` deliberately does NOT clear installationId/deviceSecret: a bare
    // 404 here also means an unknown clientKey or an unprovisioned org, and the
    // secret is issued exactly once — clearing it strands this browser forever.
    return;
  }
  if (!conditional) unconditionalHasWorked = true;

  const parsed = parseBundle(response.body, now);
  if (!parsed) return;
  bundle = parsed;
  await set(KEYS.inAppBundle, bundle);
  await pruneState(parsed, now);
}

function fetchBundle(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
) {
  return getJson<BundleResponse>(baseUrl, path, headers, true, {
    // Without no-store the browser revalidates on its own against the response's
    // ETag + Cache-Control and hands back a synthesized 200; the manually-set
    // If-None-Match never reaches the server and 304 never happens.
    cache: 'no-store',
  });
}

function bundlePath(clientKey: string, installationId: string): string {
  const key = encodeURIComponent(clientKey);
  const id = encodeURIComponent(installationId);
  return `/api/v1/orgs/${key}/in-app/bundle?installationId=${id}`;
}

async function readAuth(): Promise<DeviceAuth | null> {
  const [clientKey, baseUrl, installationId, deviceSecret] = await Promise.all([
    get<string>(KEYS.clientKey),
    get<string>(KEYS.baseUrl),
    get<string>(KEYS.installationId),
    get<string>(KEYS.deviceSecret),
  ]);
  if (!clientKey || !baseUrl || !installationId || !deviceSecret) return null;
  return { clientKey, baseUrl, installationId, deviceSecret };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Every optional field arrives from a `jsonb` column and is three-state —
 * absent, explicitly null, or present. A parser assuming only null-or-value
 * drops messages silently, which is the one failure this channel cannot detect
 * from any surface.
 *
 * The envelope is never key-validated: the backend's global success interceptor
 * spreads `message` and `timestamp` alongside the contract fields.
 */
function parseBundle(body: BundleResponse, now: number): CachedBundle | null {
  if (typeof body?.bundleVersion !== 'string') {
    log('response carried no bundleVersion');
    return null;
  }
  if (body.contractVersion !== undefined && body.contractVersion !== 1) {
    log(`unknown contractVersion ${String(body.contractVersion)}; proceeding`);
  }

  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages: InAppMessage[] = [];
  for (const candidate of raw) {
    const parsed = parseMessage(candidate);
    if (parsed) messages.push(parsed);
  }
  if (raw.length !== messages.length) {
    log(`dropped ${raw.length - messages.length} unrenderable message(s)`);
  }

  const ttl = num(body.ttlSeconds);
  return {
    bundleVersion: body.bundleVersion,
    ttlSeconds: ttl && ttl > 0 ? ttl : DEFAULT_TTL_SECONDS,
    fetchedAtMs: now,
    messages,
  };
}

function parseMessage(input: unknown): InAppMessage | null {
  if (!isRecord(input)) return null;
  const campaignId = str(input.campaignId);
  const messageId = str(input.messageId);
  const layout = str(input.layout);
  const content = isRecord(input.content) ? input.content : null;
  const headline = content ? str(content.headline) : undefined;

  if (!campaignId || !messageId || !layout || !content || !headline) {
    log('message missing a required field');
    return null;
  }
  if (!WEB_LAYOUTS.includes(layout)) {
    // Either FULLSCREEN, which is filtered server-side for web, or a newer
    // layout this build predates. Logging is the only signal an author will ever
    // get for a message that simply never appears.
    log(`layout ${layout} is not renderable on web`);
    return null;
  }

  const trigger = isRecord(input.trigger) ? input.trigger : {};
  const rules = isRecord(input.displayRules) ? input.displayRules : {};

  return {
    campaignId,
    messageId,
    variantKey: str(input.variantKey) ?? 'default',
    priority: num(input.priority) ?? 0,
    expiresAtMs: parseDate(input.expiresAt),
    triggerType: (str(trigger.type) ?? 'APP_OPEN') as InAppTriggerType,
    triggerEventName: str(trigger.eventName) ?? null,
    triggerProperties: isRecord(trigger.properties) ? trigger.properties : null,
    displayRules: {
      maxPerSession: num(rules.maxPerSession) ?? DEFAULT_RULES.maxPerSession,
      maxLifetime: num(rules.maxLifetime) ?? DEFAULT_RULES.maxLifetime,
      minSecondsBetween:
        num(rules.minSecondsBetween) ?? DEFAULT_RULES.minSecondsBetween,
      delaySeconds: num(rules.delaySeconds) ?? DEFAULT_RULES.delaySeconds,
    },
    layout: layout as InAppLayout,
    content: {
      headline,
      body: str(content.body) ?? '',
      imageUrl: str(content.imageUrl),
      backgroundColor: str(content.backgroundColor),
      textColor: str(content.textColor),
      // Absent means "not suppressed"; only an explicit false hides it.
      showCloseButton: content.showCloseButton !== false,
    },
    // `fields` arrives as null, not [], on every layout that collects nothing.
    fields: Array.isArray(input.fields)
      ? input.fields
          .map(parseField)
          .filter((field): field is InAppField => field !== null)
      : [],
    // `buttons` arrives as null, not [], when a campaign has none.
    buttons: Array.isArray(input.buttons)
      ? input.buttons
          .map(parseButton)
          .filter((button): button is InAppButton => button !== null)
      : [],
  };
}

function parseButton(input: unknown): InAppButton | null {
  if (!isRecord(input)) return null;
  const buttonId = str(input.buttonId);
  const label = str(input.label);
  const action = str(input.action);
  if (!buttonId || !label || !action) return null;

  return {
    buttonId,
    label,
    action: action as InAppAction,
    value: str(input.value),
    style: str(input.style) === 'SECONDARY' ? 'SECONDARY' : 'PRIMARY',
  };
}

const FIELD_TYPES: readonly string[] = [
  'text',
  'email',
  'tel',
  'dropdown',
  'radio',
  'checkbox',
  'rating',
];

/**
 * An unknown type is dropped rather than guessed at. Rendering a field the SDK
 * does not understand as a text box would collect an answer the server then
 * refuses, which reads to the user as the form being broken.
 */
function parseField(input: unknown): InAppField | null {
  if (!isRecord(input)) return null;
  const fieldId = str(input.fieldId);
  const label = str(input.label);
  const type = str(input.type);
  if (!fieldId || !label || !type || !FIELD_TYPES.includes(type)) return null;

  return {
    fieldId,
    type: type as InAppFieldType,
    label,
    required: input.required === true,
    placeholder: str(input.placeholder) ?? null,
    options: Array.isArray(input.options)
      ? input.options
          .map(parseFieldOption)
          .filter((option): option is InAppFieldOption => option !== null)
      : null,
    scale: num(input.scale) ?? null,
  };
}

function parseFieldOption(input: unknown): InAppFieldOption | null {
  if (!isRecord(input)) return null;
  const label = str(input.label);
  const value = str(input.value);
  return label && value ? { label, value } : null;
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

/**
 * The first message in SERVER order that survives every rule.
 *
 * There is deliberately no client-side sort. The server already emits
 * `priority DESC` then earliest expiry (open-ended last) then campaignId, which
 * is exactly the documented precedence; re-sorting here could only diverge from
 * it, and the divergence would be invisible.
 */
export function pick(
  now: number,
  type: InAppTriggerType,
  eventName: string | null,
  properties: EventProperties,
): InAppMessage | null {
  // A trigger arriving while a message is on screen is DROPPED, not queued: a
  // queued message surfaces seconds after the interaction that supposedly caused
  // it and gets attributed to the wrong action.
  if (suppressed || active !== null || !bundle) return null;

  for (const message of bundle.messages) {
    if (message.triggerType !== type) continue;
    // screen('cart') matches only SCREEN_VIEW and track('cart') only
    // CUSTOM_EVENT — the backend treats them as distinct and so must this.
    if (type !== 'APP_OPEN' && message.triggerEventName !== eventName) continue;
    if (!propertiesMatch(message.triggerProperties, properties)) continue;

    const entry = state[message.messageId];
    if (message.expiresAtMs !== null && message.expiresAtMs <= now) {
      reportExpiryOnce(message);
      continue;
    }
    if ((entry?.shown ?? 0) >= message.displayRules.maxLifetime) continue;
    if (
      (session.counts[message.messageId] ?? 0) >=
      message.displayRules.maxPerSession
    ) {
      continue;
    }
    if (
      entry &&
      now - entry.lastShownAtMs <
        message.displayRules.minSecondsBetween * MS_PER_SECOND
    ) {
      continue;
    }
    return message;
  }
  return null;
}

/**
 * Equality-AND, both sides coerced with `String()`.
 *
 * The backend types `properties` as `Record<string, string>` but validates it
 * only with `@IsObject()`, and its declared key cap is never enforced — so a
 * non-string value or an unbounded key count must not throw here.
 */
function propertiesMatch(
  want: Record<string, unknown> | null,
  got: EventProperties,
): boolean {
  if (!want) return true;
  const source = got as Record<string, unknown>;
  for (const [key, value] of Object.entries(want)) {
    if (String(source[key]) !== String(value)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * A trigger fired. Synchronous and never throws — it sits on the caller's
 * `track()` path, and an in-app failure must not take an analytics event with it.
 */
export function observe(
  type: InAppTriggerType,
  eventName: string | null,
  properties: EventProperties = {},
): void {
  try {
    const message = pick(Date.now(), type, eventName, properties);
    if (!message) return;

    // Reserved at SCHEDULE time, so a second trigger during the delay window
    // cannot start a competing message.
    active = message.messageId;
    lastTriggerEventName = eventName;
    const delay = message.displayRules.delaySeconds * MS_PER_SECOND;
    if (delay <= 0) {
      renderer?.(message);
      return;
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      renderer?.(message);
    }, delay);
  } catch (error) {
    log(`observe failed: ${error instanceof Error ? error.message : 'unknown'}`);
    active = null;
  }
}

let lastTriggerEventName: string | null = null;

export function triggerEventName(): string | null {
  return lastTriggerEventName;
}

export function onSessionOpen(): void {
  void syncSessionWindow().then(() => {
    observe('APP_OPEN', null, {});
  });
}

/** A delayed message whose moment passed leaves no trace — no beacon, no counter. */
export function cancelPending(): void {
  if (pendingTimer === null) return;
  clearTimeout(pendingTimer);
  pendingTimer = null;
  active = null;
}

export function releaseActive(): void {
  active = null;
}

export function isActive(): boolean {
  return active !== null;
}

// ---------------------------------------------------------------------------
// Counters and beacons
// ---------------------------------------------------------------------------

export async function recordImpression(
  message: InAppMessage,
  eventName: string | null,
): Promise<void> {
  const now = Date.now();
  const entry = state[message.messageId] ?? {
    shown: 0,
    lastShownAtMs: 0,
    lastSeenInBundleAtMs: now,
  };
  state = {
    ...state,
    [message.messageId]: { ...entry, shown: entry.shown + 1, lastShownAtMs: now },
  };
  session = {
    ...session,
    counts: {
      ...session.counts,
      [message.messageId]: (session.counts[message.messageId] ?? 0) + 1,
    },
  };
  await Promise.all([
    set(KEYS.inAppState, state),
    set(KEYS.inAppSession, session),
  ]);
  await enqueueBeacon(message, 'impression', { triggerEventName: eventName });
}

export async function recordClick(
  message: InAppMessage,
  buttonId: string,
): Promise<void> {
  await enqueueBeacon(message, 'clicked', { buttonId });
}

/**
 * Answers are keyed by `fieldId`, never by a destination.
 *
 * The bundle does not carry `fieldKey` at all, so the SDK could not name a
 * destination even if it wanted to — the server resolves each id against the
 * campaign it stored.
 */
export async function recordSubmit(
  message: InAppMessage,
  submission: Record<string, string>,
): Promise<void> {
  await enqueueBeacon(message, 'submitted', { submission });
}

export async function recordDismiss(
  message: InAppMessage,
  visibleSeconds: number,
): Promise<void> {
  await enqueueBeacon(message, 'dismissed', {
    visibleSeconds: Math.max(
      0,
      Math.min(MAX_VISIBLE_SECONDS, Math.round(visibleSeconds)),
    ),
  });
}

function reportExpiryOnce(message: InAppMessage): void {
  const entry = state[message.messageId];
  if (entry?.expiredReported) return;
  state = {
    ...state,
    [message.messageId]: {
      shown: entry?.shown ?? 0,
      lastShownAtMs: entry?.lastShownAtMs ?? 0,
      lastSeenInBundleAtMs: entry?.lastSeenInBundleAtMs ?? Date.now(),
      expiredReported: true,
    },
  };
  void set(KEYS.inAppState, state);
  void enqueueBeacon(message, 'expired', {});
}

/**
 * `eventType` is LOWERCASE, and no property outside the DTO may be sent.
 *
 * This route runs `forbidNonWhitelisted` with no per-endpoint override, so an
 * uppercase value or one stray key 400s the whole batch — taking up to 49 good
 * beacons with it.
 */
async function enqueueBeacon(
  message: InAppMessage,
  eventType: BeaconType,
  extra: {
    buttonId?: string;
    visibleSeconds?: number;
    triggerEventName?: string | null;
    submission?: Record<string, string>;
  },
): Promise<void> {
  const body: Record<string, unknown> = {
    messageId: message.messageId,
    campaignId: message.campaignId,
    eventType,
    // Stamped when it HAPPENED, not at flush: a beacon that waits out an offline
    // spell would otherwise land in the wrong hour bucket.
    timestamp: new Date().toISOString(),
    variantKey: message.variantKey,
  };
  if (extra.buttonId) body.buttonId = extra.buttonId;
  if (extra.visibleSeconds !== undefined) {
    body.visibleSeconds = extra.visibleSeconds;
  }
  if (extra.triggerEventName) body.triggerEventName = extra.triggerEventName;
  if (extra.submission && Object.keys(extra.submission).length > 0) {
    body.submission = extra.submission;
  }

  await addEvent(QUEUE.inAppBeacons, JSON.stringify(body));
  await trimQueue(QUEUE.inAppBeacons, MAX_QUEUED_BEACONS);
  void flushBeacons();
}

export async function flushBeacons(): Promise<void> {
  const auth = await readAuth();
  if (!auth) return;

  const pending = await allEvents(QUEUE.inAppBeacons);
  if (pending.length === 0) return;

  const path = `/api/v1/orgs/${encodeURIComponent(auth.clientKey)}/in-app/events`;
  for (let i = 0; i < pending.length; i += BEACON_BATCH_MAX) {
    const batch = pending.slice(i, i + BEACON_BATCH_MAX);
    const response = await post(
      auth.baseUrl,
      path,
      {
        installationId: auth.installationId,
        events: batch.map((row) => JSON.parse(row.body) as unknown),
      },
      { 'X-Arsel-Device-Auth': auth.deviceSecret },
      true,
    );
    // Retryable stops the drain so the next flush retries this batch; anything
    // else is settled, and holding it would wedge everything behind it.
    if (response.result === RESULT.retryable) return;
    for (const row of batch) {
      if (row.id !== undefined) await removeEvent(QUEUE.inAppBeacons, row.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Prune on age, never on bundle membership.
 *
 * The bundle is truncated to 25 messages server-side, so absence is not death:
 * pruning on membership would reset the lifetime counters of a message pushed
 * past the cap by a higher-priority campaign, and it would show all over again.
 */
async function pruneState(current: CachedBundle, now: number): Promise<void> {
  const present = new Set(current.messages.map((message) => message.messageId));
  const next: Record<string, MessageState> = {};
  for (const [id, entry] of Object.entries(state)) {
    const lastSeen = present.has(id) ? now : entry.lastSeenInBundleAtMs;
    if (now - lastSeen > STATE_TTL_MS) continue;
    next[id] = { ...entry, lastSeenInBundleAtMs: lastSeen };
  }
  state = next;
  await set(KEYS.inAppState, state);
}

/** Session counters reset when the shared session window rolls over. */
async function syncSessionWindow(): Promise<void> {
  const startedAt = (await get<number>(KEYS.sessionStartedAt)) ?? 0;
  if (session.startedAt === startedAt) return;
  session = { startedAt, counts: {} };
  await set(KEYS.inAppSession, session);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** `CODE_NO_RESPONSE` from transport; re-declared to avoid a value import cycle. */
const CODE_OFFLINE = -1;
const NOT_MODIFIED = 304;

export type InAppLayout =
  | 'MODAL'
  | 'BANNER_TOP'
  | 'BANNER_BOTTOM'
  | 'IMAGE_ONLY';

export type InAppTriggerType = 'APP_OPEN' | 'SCREEN_VIEW' | 'CUSTOM_EVENT';

export type InAppAction = 'DEEP_LINK' | 'URL' | 'DISMISS' | 'CUSTOM_EVENT';

type BeaconType =
  | 'impression'
  | 'clicked'
  | 'dismissed'
  | 'expired'
  | 'submitted';

export interface InAppButton {
  buttonId: string;
  label: string;
  action: InAppAction;
  value?: string;
  style: 'PRIMARY' | 'SECONDARY';
}

export interface InAppContent {
  headline: string;
  body: string;
  imageUrl?: string;
  backgroundColor?: string;
  textColor?: string;
  showCloseButton: boolean;
}

export interface InAppDisplayRules {
  maxPerSession: number;
  maxLifetime: number;
  minSecondsBetween: number;
  delaySeconds: number;
}

export interface InAppMessage {
  campaignId: string;
  messageId: string;
  variantKey: string;
  priority: number;
  /** Parsed once at cache time; the wire carries an ISO string. */
  expiresAtMs: number | null;
  triggerType: InAppTriggerType;
  triggerEventName: string | null;
  triggerProperties: Record<string, unknown> | null;
  displayRules: InAppDisplayRules;
  layout: InAppLayout;
  content: InAppContent;
  buttons: InAppButton[];
  /** Present only on FORM and RATING. Never carries a destination key. */
  fields: InAppField[];
}

export type InAppFieldType =
  | 'text'
  | 'email'
  | 'tel'
  | 'dropdown'
  | 'radio'
  | 'checkbox'
  | 'rating';

export interface InAppFieldOption {
  label: string;
  value: string;
}

export interface InAppField {
  /** What an answer is keyed by. The server owns where it lands. */
  fieldId: string;
  type: InAppFieldType;
  label: string;
  required: boolean;
  placeholder: string | null;
  options: InAppFieldOption[] | null;
  scale: number | null;
}

interface DeviceAuth {
  clientKey: string;
  baseUrl: string;
  installationId: string;
  deviceSecret: string;
}

interface CachedBundle {
  bundleVersion: string;
  ttlSeconds: number;
  fetchedAtMs: number;
  messages: InAppMessage[];
}

interface MessageState {
  shown: number;
  lastShownAtMs: number;
  lastSeenInBundleAtMs: number;
  expiredReported?: true;
}

interface SessionCounts {
  startedAt: number;
  counts: Record<string, number>;
}

interface BundleResponse {
  contractVersion?: number;
  bundleVersion?: string;
  ttlSeconds?: number;
  messages?: unknown[];
}
