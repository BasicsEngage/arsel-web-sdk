import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODE_NO_RESPONSE, RESULT, classify, getJson, post } from '../src/transport';

describe('classify', () => {
  it('2xx is success', () => {
    expect(classify(200, false)).toBe(RESULT.success);
    expect(classify(202, false)).toBe(RESULT.success);
    expect(classify(299, true)).toBe(RESULT.success);
  });

  it('timeouts, throttles and server errors are retryable', () => {
    for (const code of [408, 429, 500, 502, 503, 599]) {
      expect(classify(code, false)).toBe(RESULT.retryable);
      expect(classify(code, true)).toBe(RESULT.retryable);
    }
  });

  it('auth failures on an authenticated route mean the secret is dead', () => {
    // Including 404: the backend's deliberately opaque not-found on authed routes.
    for (const code of [401, 403, 404]) {
      expect(classify(code, true)).toBe(RESULT.reauth);
    }
  });

  it('a bare 404 is retryable — the channel may simply not be switched on yet', () => {
    expect(classify(404, false)).toBe(RESULT.retryable);
  });

  it('other 4xx are permanent', () => {
    for (const code of [400, 405, 410, 422]) {
      expect(classify(code, false)).toBe(RESULT.permanent);
    }
  });
});

describe('post', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stamps X-Arsel-SDK and merges caller headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 202,
      json: () => Promise.resolve({}),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await post('https://api.example.com', '/v1/x', {}, { Authorization: 'Bearer k' });

    const headers = fetchMock.mock.calls[0]![1].headers;
    expect(headers['X-Arsel-SDK']).toMatch(/^web\/\d+\.\d+\.\d+$/);
    expect(headers.Authorization).toBe('Bearer k');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('a network failure is retryable with no status code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const response = await post('https://api.example.com', '/v1/x', {});

    expect(response.result).toBe(RESULT.retryable);
    expect(response.code).toBe(CODE_NO_RESPONSE);
  });
});

describe('getJson', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stamps X-Arsel-SDK on reads too', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ keyVersion: 1 }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const body = await getJson<{ keyVersion: number }>('https://api.example.com', '/cfg');

    expect(body?.keyVersion).toBe(1);
    expect(fetchMock.mock.calls[0]![1].headers['X-Arsel-SDK']).toMatch(/^web\//);
  });
});
