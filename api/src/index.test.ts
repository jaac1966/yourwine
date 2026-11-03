import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from './index';
import { getWine, upsertWine } from './db';
import { createFakeDb, type FakeDb } from './fakeDb';
import { wineId } from './wineId';

const wine = { name: 'Test Red', country: 'Mexico', color: 'red', acidity: 3, sweetness: 2, tannin: 4, body: 4, confidence: 0.9 };

const puts: Array<[string, string]> = [];

const env = (db: FakeDb = createFakeDb(), extra: Record<string, unknown> = {}) => ({
  USAGE: {
    get: async () => null,
    put: async (k: string, v: string) => {
      puts.push([k, v]);
    },
  },
  DB: db,
  META_API_KEY: 'test',
  BASETEN_API_KEY: 'test',
  ...extra,
});

const scanJson = (body: object, db?: FakeDb) =>
  app.request('/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env(db));

const postJson = (path: string, body: object, db: FakeDb) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env(db));

function mockMeta(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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

  it('includes scoring debug with axes, deltas, pick, score and label', async () => {
    mockMeta(metaOk(JSON.stringify(wine)));
    const res = await scanJson({ photo_b64: 'abc123', user: 'alex' });
    const data = await res.json();
    expect(data.debug.scan_id).toBe(data.scan_id);
    expect(data.debug.wine_axes_used_for_score).toEqual({ acidity: 3, sweetness: 2, tannin: 4, body: 4 });
    expect(data.debug.profile_axes_before).toEqual({ acidity: 2, sweetness: 2, tannin: 4, body: 4 });
    expect(data.debug.deltas).toEqual({ acidity: 1, sweetness: 0, tannin: 0, body: 0 });
    expect(data.debug.picked_axis).toBe('tannin');
    expect(data.debug.magnitude).toBeNull();
    expect(data.debug.direction).toBeNull();
    expect(data.debug.score).toBe(94);
    expect(data.debug.label).toBe('strong match');
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
    const a = (await first.json()).red;
    expect(a.n).toBe(1);
    expect(a.axes.acidity).toBeCloseTo(3.35, 8);
    expect(a.axes.sweetness).toBeCloseTo(1.55, 8);
    expect(a.axes.tannin).toBeCloseTo(4.45, 8);
    expect(a.axes.body).toBeCloseTo(4.45, 8);
    const second = await postJson('/feedback', { scan_id, verdict: 'loved' }, db);
    const b = (await second.json()).red;
    expect(b.n).toBe(2);
    expect(b.axes.acidity).toBeCloseTo(3.845, 8);
    expect(b.axes.sweetness).toBeCloseTo(1.385, 8);
    expect(b.axes.tannin).toBeCloseTo(4.615, 8);
    expect(b.axes.body).toBeCloseTo(4.615, 8);
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

  it('includes update debug with wine axes, before/after profile, step and n', async () => {
    const db = createFakeDb();
    mockMeta(metaOk(JSON.stringify(wine)));
    const scan = await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    const { scan_id } = await scan.json();
    const res = await postJson('/feedback', { scan_id, verdict: 'loved' }, db);
    const data = await res.json();
    expect(data.debug.scan_id).toBe(scan_id);
    expect(data.debug.wine_axes_used_for_update).toEqual({ acidity: 3, sweetness: 2, tannin: 4, body: 4 });
    expect(data.debug.profile_before).toEqual({ acidity: 2, sweetness: 2, tannin: 4, body: 4 });
    expect(data.debug.profile_after.acidity).toBeCloseTo(2.45, 8);
    expect(data.debug.profile_after.sweetness).toBe(2);
    expect(data.debug.profile_after.tannin).toBe(4);
    expect(data.debug.profile_after.body).toBe(4);
    expect(data.debug.step).toBe(0.45);
    expect(data.debug.n).toBe(0);
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

  it('resets the feedback count so the first loved after reset uses the full 0.45 step', async () => {
    const db = createFakeDb();
    mockMetaSequence(metaOk(JSON.stringify(wine)), metaOk(JSON.stringify(wine)));
    const scan = await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    const { scan_id } = await scan.json();
    await postJson('/feedback', { scan_id, verdict: 'loved' }, db);
    await postJson('/feedback', { scan_id, verdict: 'loved' }, db);
    await postJson('/reset', {}, db);
    const rescan = await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    const fb = await postJson('/feedback', { scan_id: (await rescan.json()).scan_id, verdict: 'loved' }, db);
    const red = (await fb.json()).red;
    expect(red.n).toBe(1);
    // alex red base is 2/2/4/4, wine is 3/2/4/4: only acidity moves, by 0.45 of the distance.
    expect(red.axes.acidity).toBeCloseTo(2.45, 8);
    expect(red.axes.sweetness).toBe(2);
    expect(red.axes.tannin).toBe(4);
    expect(red.axes.body).toBe(4);
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

describe('POST /explain', () => {
  const body = {
    wine: { name: 'Test Red', country: 'Mexico', color: 'red', acidity: 3, sweetness: 2, tannin: 4, body: 4 },
    score: 78,
    user: 'alex',
    lastLoved: { grape: 'Zinfandel', country: 'USA' },
  };
  const explain = (e: ReturnType<typeof env>, b: object = body) =>
    app.request('/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }, e);
  const explainOk = (text: string) => ({ usage: { total_tokens: 10 }, choices: [{ message: { content: text } }] });

  it('uses Baseten with the verdict as ground truth when BASETEN_API_KEY is set', async () => {
    const fetchMock = mockMeta(explainOk('You will love it. It is great.'));
    // A stale body.profile must be ignored: alex's server overlay is 2/2/4/4.
    const res = await explain(env(), { ...body, profile: { acidity: 2, sweetness: 4, tannin: 2, body: 3 } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.text).toBe('You will love it. It is great.');
    expect(data.explained_by).toBe('spark-open-baseten');
    expect(data.debug).toMatchObject({
      picked_axis: 'tannin',
      magnitude: null,
      direction: null,
      score: 78,
      label: 'likely match',
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://inference.baseten.co/v1/chat/completions');
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.max_tokens).toBe(2000);
    expect(sent.reasoning_effort).toBe('low');
    expect(sent.messages[0]).toMatchObject({ role: 'system' });
    expect(sent.messages[0].content).toContain('never contradict it');
    expect(sent.messages[1].content).toContain('"verdict":"likely match"');
    expect(sent.messages[1].content).toContain('"delta_wine_minus_profile":{"acidity":1,"sweetness":0,"tannin":0,"body":0}');
    expect(sent.messages[1].content).toContain('"last_loved":{"grape":"Zinfandel","country":"USA"}');
    expect(sent.messages[1].content).toContain('you may mention the wine the user last loved in sentence 2');
    expect(sent.messages[1].content).toContain('"picked":{"axis":"tannin","relation":"close match"}');
    expect(sent.messages[1].content).toContain('sentence 2 says this axis is close to what the user enjoys');
    expect(sent.messages[1].content).not.toContain('magnitude');
    expect(sent.messages[1].content).not.toContain('direction');
    expect(sent.messages[1].content).not.toContain('"furthest"');
    expect(sent.messages[1].content).not.toContain('"closest"');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('keeps magnitude and direction in the prompt for low scores', async () => {
    const fetchMock = mockMeta(explainOk('ok. Fine.'));
    const res = await explain(env(), { ...body, score: 35 });
    expect(res.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.messages[1].content).toContain(
      '"picked":{"axis":"acidity","delta":1,"magnitude":"noticeably","direction":"higher"}',
    );
    expect(sent.messages[1].content).toContain('given magnitude word');
  });

  it.each([
    {
      name: 'largest delta',
      score: 35,
      wine: { acidity: 3.9, sweetness: 1, tannin: 3, body: 3 },
      axis: 'acidity',
      magnitude: 'much',
    },
    {
      name: 'tie prefers tannin',
      score: 35,
      wine: { acidity: 2.9, sweetness: 2, tannin: 5, body: 4 },
      axis: 'tannin',
      magnitude: 'noticeably',
    },
  ])('template names the $axis axis ($name)', async ({ score, wine, axis, magnitude }) => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await explain(env(createFakeDb(), { BASETEN_API_KEY: '' }), {
      ...body,
      score,
      wine: { ...body.wine, ...wine },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const second = String(data.text).split('. ')[1];
    expect(second).toContain(axis);
    expect(second).toContain(magnitude);
    expect(data.debug.wine_axes).toEqual(wine);
    expect(data.debug.profile_axes).toEqual({ acidity: 2, sweetness: 2, tannin: 4, body: 4 });
    expect(data.debug).toMatchObject({ picked_axis: axis, magnitude, direction: 'higher', score, label: 'unlikely match' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('template sentence 2 uses close-match wording for high scores', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await explain(env(createFakeDb(), { BASETEN_API_KEY: '' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    const second = String(data.text).split('. ')[1];
    expect(second).toContain('close to what you enjoy');
    for (const w of ['slightly', 'noticeably', 'much', 'higher', 'lower']) {
      expect(second).not.toContain(w);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('omits last_loved from the prompt when null', async () => {
    const fetchMock = mockMeta(explainOk('ok. Fine.'));
    const res = await explain(env(), { ...body, lastLoved: null });
    expect(res.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.messages[1].content).not.toContain('last_loved');
    expect(sent.messages[1].content).not.toContain('you may mention');
  });

  it.each([['missing', undefined], ['empty', '']])(
    'uses the local template without calling any model when BASETEN_API_KEY is %s',
    async (_label, key) => {
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const res = await explain(env(createFakeDb(), { BASETEN_API_KEY: key }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.explained_by).toBe('template');
      expect(data.text).toContain('likely match');
      expect(String(data.text).split('. ')).toHaveLength(2);
      expect(data.debug).toMatchObject({
        picked_axis: 'tannin',
        magnitude: null,
        direction: null,
        score: 78,
        label: 'likely match',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      score: 98,
      user: 'alex',
      wine: { acidity: 2, sweetness: 4, tannin: 5, body: 3 },
      words: ['love', 'strong match'],
    },
    {
      score: 35,
      user: 'luis',
      wine: { acidity: 2, sweetness: 1, tannin: 2, body: 3 },
      words: ["won't", 'unlikely match'],
    },
  ])('template first sentence matches the verdict for score $score', async ({ score, user, wine, words }) => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await explain(env(createFakeDb(), { BASETEN_API_KEY: '' }), {
      ...body,
      score,
      user,
      wine: { ...body.wine, ...wine },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const first = String(data.text).split('. ')[0];
    for (const w of words) expect(first).toContain(w);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a known user', async () => {
    const missing = await explain(env(), { ...body, user: undefined });
    expect(missing.status).toBe(400);
    const unknown = await explain(env(), { ...body, user: 'mallory' });
    expect(unknown.status).toBe(404);
  });

  it('reports one consistent profile through scan → explain → feedback → scan', async () => {
    const db = createFakeDb();
    mockMetaSequence(metaOk(JSON.stringify(wine)), metaOk(JSON.stringify(wine)));
    await postJson('/reset', {}, db);
    const scan1 = await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    const s1 = await scan1.json();
    const exp = await explain(env(db, { BASETEN_API_KEY: '' }), {
      wine: s1.wine,
      score: s1.matches[0].score,
      user: 'alex',
      lastLoved: { grape: 'Zinfandel', country: 'USA' },
    });
    const e = await exp.json();
    expect(e.debug.profile_axes).toEqual(s1.debug.profile_axes_before);
    const fb = await postJson('/feedback', { scan_id: s1.scan_id, verdict: 'loved' }, db);
    const f = await fb.json();
    expect(f.debug.profile_before).toEqual(s1.debug.profile_axes_before);
    const scan2 = await scanJson({ photo_b64: 'abc123', user: 'alex' }, db);
    const s2 = await scan2.json();
    expect(s2.debug.profile_axes_before).toEqual(f.debug.profile_after);
  });
});

describe('CORS', () => {
  it('allows any origin', async () => {
    const res = await app.request('/health', { headers: { Origin: 'https://example.com' } }, env());
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
