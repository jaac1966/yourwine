import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from './index';

const wine = { name: 'Test Red', country: 'Mexico', color: 'red', acidity: 3, sweetness: 2, tannin: 4, body: 4, confidence: 0.9 };

const puts: Array<[string, string]> = [];

const env = () => ({
  USAGE: {
    get: async () => null,
    put: async (k: string, v: string) => {
      puts.push([k, v]);
    },
  },
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

function mockMetaSequence(...payloads: unknown[]) {
  const fetchMock = vi.fn();
  for (const p of payloads) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(p), { status: 200 }));
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
  puts.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
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

  it('returns 400 for invalid JSON', async () => {
    const bad = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' };
    const scan = await app.request('/scan', bad, env());
    expect(scan.status).toBe(400);
    expect(await scan.json()).toEqual({ error: 'invalid json' });
    const feedback = await app.request('/feedback', bad, env());
    expect(feedback.status).toBe(400);
    expect(await feedback.json()).toEqual({ error: 'invalid json' });
  });

  it('escalates to Wonder on low confidence and keeps the higher one', async () => {
    const sparkWine = { ...wine, name: 'Spark Guess', confidence: 0.5 };
    const wonderWine = { ...wine, name: 'Wonder Read', confidence: 0.95 };
    const fetchMock = mockMetaSequence(metaOk(JSON.stringify(sparkWine)), metaOk(JSON.stringify(wonderWine)));
    const res = await scanJson({ photo_b64: 'abc123', user: 'alex' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(first.model).toBe('muse-spark-1.3');
    expect(second.model).toBe('muse-wonder-1.0');
    expect({ ...second, model: first.model }).toEqual(first);
    const data = await res.json();
    expect(data.wine.name).toBe('Wonder Read');
    expect(data.readBy).toBe('wonder');
    const today = new Date().toISOString().slice(0, 10);
    expect(puts.map(([k]) => k)).toEqual([`usage:${today}:meta`, `usage:${today}:meta`]);
  });

  it('never calls Wonder when Spark confidence is high', async () => {
    const fetchMock = mockMeta(metaOk(JSON.stringify(wine)));
    const res = await scanJson({ photo_b64: 'abc123', user: 'alex' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await res.json()).readBy).toBe('spark');
  });
});

describe('POST /transcribe', () => {
  it('transcribes wav audio via Muse Voice Transcribe and tracks meta usage', async () => {
    const fetchMock = mockMeta({ transcript: 'would I like this one', audioDurationMs: 7000 });
    const bytes = new Uint8Array(64000);
    const form = new FormData();
    form.set('audio', new File([bytes], 'audio.wav', { type: 'audio/wav' }));
    const res = await app.request('/transcribe', { method: 'POST', body: form }, env());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'would I like this one' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[string, { body: FormData }]>;
    expect(calls[0][0]).toBe('https://api.meta.ai/v1/asr/transcribe');
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith('https://api.meta.ai/v1/asr/transcribe');
    const sent = calls[0][1].body as FormData;
    const partNames = Array.from(sent as unknown as Array<[string, unknown]>).map(([name]) => name);
    expect(partNames).toEqual(['request', 'audio']);
    expect(typeof sent.get('request')).toBe('string');
    expect(JSON.parse(sent.get('request') as string)).toEqual({
      mode: 'PUSH_TO_TALK',
      model: 'muse-voice-transcribe-1.0',
      audioEncoding: 'WAV',
    });
    const sentAudio = sent.get('audio');
    expect(sentAudio).toBeInstanceOf(File);
    expect((sentAudio as File).name).toBe('audio.wav');
    expect((sentAudio as File).type).toBe('audio/wav');
    expect(new Uint8Array(await (sentAudio as File).arrayBuffer())).toEqual(bytes);
    const today = new Date().toISOString().slice(0, 10);
    expect(puts).toEqual([[`usage:${today}:meta`, '7']]);
  });

  it('returns 502 with upstream status and excerpt when transcription fails', async () => {
    mockMeta({ error: 'bad' }, 500);
    const form = new FormData();
    form.set('audio', new File([new Uint8Array([1, 2, 3])], 'audio.wav', { type: 'audio/wav' }));
    const res = await app.request('/transcribe', { method: 'POST', body: form }, env());
    expect(res.status).toBe(502);
    expect(res.headers.get('x-upstream')).toBe('500 {"error":"bad"}');
    expect(await res.json()).toEqual({ error: 'transcribe: 500 {"error":"bad"}' });
    expect(puts).toEqual([]);
  });
});

describe('CORS', () => {
  it('allows any origin', async () => {
    const res = await app.request('/health', { headers: { Origin: 'https://example.com' } }, env());
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
