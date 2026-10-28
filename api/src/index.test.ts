import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from './index';

const wine = { name: 'Test Red', country: 'Mexico', color: 'red', acidity: 3, sweetness: 2, tannin: 4, body: 4, confidence: 0.9 };

const env = () => ({
  USAGE: { get: async () => null, put: async () => {} },
  META_API_KEY: 'test',
  BASETEN_API_KEY: 'test',
});

const scanJson = (body: object) =>
  app.request('/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env());

function mockMeta(payload: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentImageUrl(fetchMock: ReturnType<typeof vi.fn>) {
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  return body.messages[0].content[1].image_url.url as string;
}

function metaOk(content: string) {
  return { usage: { total_tokens: 10 }, choices: [{ message: { content } }] };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /scan', () => {
  it('accepts JSON with a pre-encoded photo and uses it as-is', async () => {
    const fetchMock = mockMeta(metaOk(JSON.stringify(wine)));
    const res = await scanJson({ photo_b64: 'abc123', mime: 'image/png', user: 'alex', buddies: 'ana,luis' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.wine.color).toBe('red');
    expect(data.matches.map((m: { user: string }) => m.user)).toEqual(['alex', 'ana', 'luis']);
    expect(sentImageUrl(fetchMock)).toBe('data:image/png;base64,abc123');
  });

  it('accepts multipart with a photo file', async () => {
    const fetchMock = mockMeta(metaOk(JSON.stringify(wine)));
    const form = new FormData();
    form.set('photo', new File([new Uint8Array([1, 2, 3])], 'label.jpg', { type: 'image/jpeg' }));
    form.set('user', 'alex');
    const res = await app.request('/scan', { method: 'POST', body: form }, env());
    expect(res.status).toBe(200);
    expect(sentImageUrl(fetchMock)).toBe('data:image/jpeg;base64,AQID');
  });

  it('returns 502 when the model returns no content', async () => {
    mockMeta({ usage: { total_tokens: 10 }, choices: [{ message: {} }] });
    const res = await scanJson({ photo_b64: 'abc123', user: 'alex' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'could not read label' });
  });

  it('returns 502 when the wine has no color', async () => {
    mockMeta(metaOk(JSON.stringify({ name: 'mystery bottle' })));
    const res = await scanJson({ photo_b64: 'abc123', user: 'alex' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'could not read label' });
  });

  it('returns 502 when the model call fails', async () => {
    mockMeta({ error: 'bad' }, 500);
    const res = await scanJson({ photo_b64: 'abc123', user: 'alex' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'label read failed' });
  });
});

describe('CORS', () => {
  it('allows any origin', async () => {
    const res = await app.request('/health', { headers: { Origin: 'https://example.com' } }, env());
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
