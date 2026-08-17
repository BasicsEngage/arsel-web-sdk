import { KEYS, set } from './store';
import { SDK_VERSION } from './version';

/** Identifies the SDK build on every request; the backend records it. */
const SDK_HEADER = { 'X-Arsel-SDK': `web/${SDK_VERSION}` };

export const RESULT = {
  success: 'success',
  retryable: 'retryable',
  permanent: 'permanent',
  reauth: 'reauth',
} as const;

export type Result = (typeof RESULT)[keyof typeof RESULT];

export interface Response<T = unknown> {
  result: Result;
  code: number;
  body: T | null;
}

/** No status line at all — DNS failure, offline, TLS error. */
export const CODE_NO_RESPONSE = -1;

/**
 * Status → retry policy. Pure, and the same table the Android SDK uses: this is
 * the decision that separates a browser that eventually delivers from one that
 * gives up forever.
 */
export function classify(code: number, authenticated: boolean): Result {
  if (code >= 200 && code <= 299) return RESULT.success;
  if (code === 408 || code === 429 || (code >= 500 && code <= 599)) {
    return RESULT.retryable;
  }
  // On an authed route these all mean one thing behind the backend's
  // deliberately opaque 404: this secret is no longer accepted.
  if (authenticated && (code === 401 || code === 403 || code === 404)) {
    return RESULT.reauth;
  }
  // An unknown push key and an org whose channel is not switched on yet both
  // answer a bare 404. The second is ordinary onboarding, so giving up
  // permanently here would strand a browser that would have worked tomorrow.
  if (code === 404) return RESULT.retryable;
  return RESULT.permanent;
}

async function record(path: string, code: number): Promise<void> {
  // Diagnostics only; nothing branches on it. Failures here must never mask the
  // request's own outcome.
  try {
    await Promise.all([
      set(KEYS.lastResponseCode, code),
      set(KEYS.lastResponsePath, path),
      set(KEYS.lastResponseAtMs, Date.now()),
    ]);
  } catch {
    /* diagnostics are best-effort */
  }
}

export async function post<T = unknown>(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  authenticated = false,
): Promise<Response<T>> {
  let response: globalThis.Response;
  try {
    response = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...SDK_HEADER, ...headers },
      body: JSON.stringify(body),
      // The SDK never relies on cookies, and sending them would attach a
      // first-party session to a cross-origin call for no reason.
      credentials: 'omit',
      keepalive: true,
    });
  } catch {
    await record(path, CODE_NO_RESPONSE);
    return { result: RESULT.retryable, code: CODE_NO_RESPONSE, body: null };
  }

  await record(path, response.status);
  const result = classify(response.status, authenticated);
  let parsed: T | null = null;
  try {
    parsed = (await response.json()) as T;
  } catch {
    /* an empty or non-JSON body is fine — the status is what matters */
  }
  return { result, code: response.status, body: parsed };
}

export async function getJson<T>(
  baseUrl: string,
  path: string,
): Promise<T | null> {
  try {
    const response = await fetch(baseUrl + path, {
      credentials: 'omit',
      headers: SDK_HEADER,
    });
    await record(path, response.status);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    await record(path, CODE_NO_RESPONSE);
    return null;
  }
}
