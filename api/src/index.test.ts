import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from './index';
import { getWine, upsertWine } from './db';
import { createFakeDb, type FakeDb } from './fakeDb';
import { wineId } from './wineId';

const wine = { name: 'Test Red', country: 'Mexico', color: 'red', acidity: 3, sweetness: 2, tannin: 4, body: 4, confidence: 0.9 };

const puts: Array<[string, string]> = [];

const env = (db: FakeDb = createFakeDb()) => ({
  USAGE: {
    get: async () => null,
    put: async (k: string, v: string) => {
      puts.push([k, v]);
    },
  },
  DB: db,
  META_API_KEY: 'test',
  BASETEN_API_KEY: 'test',
});

const scanJson = (body: object, db?: FakeDb) =>
  app.request('/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env(db));

const postJson = (path: string, body: object, db: FakeDb) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env(db));

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

  it('uses the cached wine on hit and skips Wonder even at low confidence', async () => {
    const db = createFakeDb();
    const id = wineId('', wine.name, undefined);
    await upsertWine(db, {
      id, producer: null, name: wine.name, vintage: null, region: null, country: 'Mexico',
      grapes: null, abv: null, color: 'red', acidity: 1, sweetness: 1, tannin: 1, body: 1,
      source: 'seed', confidence: null,
    });
    const fetchMock = mockMeta(metaOk(JSON.stringify({ ...wine, confidence: 0.5 })));
    const res = await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data.cache_hit).toBe(1);
    expect(data.read_by).toBe('seed');
    expect(data.scan_id).toBe(1);
    expect(data.wine).toMatchObject({ acidity: 1, sweetness: 1, tannin: 1, body: 1 });
    expect((await getWine(db, id))?.scanCount).toBe(2);
  });

  it('inserts the wine on miss and hits the cache on rescan', async () => {
    const db = createFakeDb();
    mockMetaSequence(metaOk(JSON.stringify(wine)), metaOk(JSON.stringify(wine)));
    const first = await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    expect((await first.json()).cache_hit).toBe(0);
    const second = await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    const data = await second.json();
    expect(data.cache_hit).toBe(1);
    expect(data.scan_id).toBe(2);
  });
});

describe('POST /feedback', () => {
  it('moves the overlay toward the wine and persists across calls', async () => {
    const db = createFakeDb();
    mockMeta(metaOk(JSON.stringify({ ...wine, acidity: 5, sweetness: 1, tannin: 5, body: 5 })));
    const scan = await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    const { scan_id } = await scan.json();
    const first = await postJson('/feedback', { scan_id, verdict: 'loved' }, db);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      red: { axes: { acidity: 2.5, sweetness: 1.5, tannin: 4.5, body: 4.5 }, n: 1 },
    });
    const second = await postJson('/feedback', { scan_id, verdict: 'loved' }, db);
    expect(await second.json()).toMatchObject({
      red: { axes: { acidity: 3, sweetness: 1, tannin: 5, body: 5 }, n: 2 },
    });
  });

  it('caps overlays at 1 and 5', async () => {
    const db = createFakeDb();
    mockMetaSequence(
      metaOk(JSON.stringify({ ...wine, tannin: 1 })),
      metaOk(JSON.stringify({ ...wine, name: 'Pale Red', tannin: 2 })),
    );
    const alex = await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    const ana = await scanJson({ photo_b64: 'abc123', user: 'ana' }, db);
    const alexId = (await alex.json()).scan_id;
    const anaId = (await ana.json()).scan_id;
    // alex red tannin 4, wine tannin 1, pushed away three times: 4.5, 5, stays 5.
    await postJson('/feedback', { scan_id: alexId, verdict: 'not_for_me' }, db);
    await postJson('/feedback', { scan_id: alexId, verdict: 'not_for_me' }, db);
    const third = await postJson('/feedback', { scan_id: alexId, verdict: 'not_for_me' }, db);
    expect(await third.json()).toMatchObject({ red: { axes: { tannin: 5 }, n: 3 } });
    // ana red tannin 1, wine tannin 2, pushed away: clamps at 1.
    const low = await postJson('/feedback', { scan_id: anaId, verdict: 'not_for_me' }, db);
    expect(await low.json()).toMatchObject({ red: { axes: { tannin: 1 }, n: 1 } });
  });

  it('returns 404 for unknown scans and 400 for bad input', async () => {
    const db = createFakeDb();
    const missing = await postJson('/feedback', { scan_id: 999, verdict: 'loved' }, db);
    expect(missing.status).toBe(404);
    const noId = await postJson('/feedback', { verdict: 'loved' }, db);
    expect(noId.status).toBe(400);
    const badVerdict = await postJson('/feedback', { scan_id: 1, verdict: 'meh' }, db);
    expect(badVerdict.status).toBe(400);
  });
});

describe('POST /reset', () => {
  it('clears scans, re-seeds profiles, keeps wines', async () => {
    const db = createFakeDb();
    mockMetaSequence(metaOk(JSON.stringify(wine)), metaOk(JSON.stringify(wine)));
    const scan = await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    await postJson('/feedback', { scan_id: (await scan.json()).scan_id, verdict: 'loved' }, db);
    const reset = await postJson('/reset', {}, db);
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ ok: true });
    const empty = await app.request('/usage', {}, env(db));
    expect(await empty.json()).toMatchObject({ scans: 0, cache_hits: 0 });
    const rescan = await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    const data = await rescan.json();
    expect(data.cache_hit).toBe(1);
    const again = await postJson('/feedback', { scan_id: data.scan_id, verdict: 'loved' }, db);
    expect(await again.json()).toMatchObject({ red: { n: 1 } });
  });
});

describe('GET /usage', () => {
  it('includes scan counts for today', async () => {
    const db = createFakeDb();
    mockMetaSequence(metaOk(JSON.stringify(wine)), metaOk(JSON.stringify(wine)));
    await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    const res = await app.request('/usage', {}, env(db));
    expect(await res.json()).toMatchObject({ scans: 2, cache_hits: 1 });
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
