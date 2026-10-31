import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { applyFeedback, fourAxisMatch, type Color, type Profile } from './fourAxisMatch';
import {
  getProfile, getScan, getWine, insertScan, resetDemo, saveProfile, scanStats,
  seedProfilesIfEmpty, setScanFeedback, upsertWine, type D1, type NewWine,
} from './db';
import { wineId } from './wineId';

type KV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

type Env = {
  USAGE: KV;
  DB: D1;
  META_API_KEY: string;
  BASETEN_API_KEY: string;
};

const app = new Hono<{ Bindings: Env }>();
app.use(cors({ origin: '*', allowMethods: ['GET', 'POST'] }));
app.onError((err, c) => {
  if (err instanceof SyntaxError) return c.json({ error: 'invalid json' }, 400);
  console.error(err);
  return c.text('Internal Server Error', 500);
});
type LabelWine = {
  producer?: string;
  winery?: string;
  name: string;
  vintage?: number | null;
  region?: string;
  country?: string;
  grapes?: string[];
  alcohol?: number | null;
  color: Color;
  acidity: number;
  sweetness: number;
  tannin: number;
  body: number;
  confidence?: number;
};

const labelSchema = {
  name: 'wine_label',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      producer: { type: 'string' },
      country: { type: 'string' },
      region: { type: 'string' },
      grapes: { type: 'array', items: { type: 'string' } },
      vintage: { type: ['integer', 'null'] },
      alcohol: { type: ['number', 'null'] },
      color: { type: 'string', enum: ['red', 'white', 'rose', 'sparkling'] },
      acidity: { type: 'integer', minimum: 1, maximum: 5 },
      sweetness: { type: 'integer', minimum: 1, maximum: 5 },
      tannin: { type: 'integer', minimum: 1, maximum: 5 },
      body: { type: 'integer', minimum: 1, maximum: 5 },
      confidence: { type: 'number' },
    },
    required: ['name', 'country', 'color', 'acidity', 'sweetness', 'tannin', 'body', 'confidence'],
  },
};

async function trackUsage(env: Env, provider: 'meta' | 'baseten', tokens: number) {
  if (!tokens) return;
  const key = `usage:${new Date().toISOString().slice(0, 10)}:${provider}`;
  const current = Number((await env.USAGE.get(key)) ?? 0);
  await env.USAGE.put(key, String(current + tokens));
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function readLabel(apiKey: string, model: string, mime: string, b64: string) {
  const res = await fetch('https://api.meta.ai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Identify the ONE wine bottle held in the hand or closest to the camera. Ignore bottles on the shelf behind it. Read its label and return only the JSON.' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: labelSchema },
      max_tokens: 2000,
    }),
  });
  if (!res.ok) {
    console.error(res.status, await res.text());
    return null;
  }
  const data = await res.json();
  let wine = null;
  try {
    const content = data?.choices?.[0]?.message?.content;
    wine = content ? JSON.parse(content) : null;
  } catch {
    wine = null;
  }
  return { wine, tokens: data?.usage?.total_tokens ?? 0 };
}

app.get('/health', (c) => c.json({ ok: true }));

app.post('/scan', async (c) => {
  let b64 = '';
  let mime = 'image/jpeg';
  let user = '';
  let buddies = '';
  if ((c.req.header('content-type') ?? '').includes('application/json')) {
    const body = await c.req.json();
    b64 = body.photo_b64 ?? '';
    mime = body.mime ?? 'image/jpeg';
    user = body.user ?? '';
    buddies = body.buddies ?? '';
    if (!b64 || !user) return c.json({ error: 'photo_b64 and user required' }, 400);
  } else {
    const form = await c.req.formData();
    const photo = form.get('photo');
    const u = form.get('user');
    const b = form.get('buddies');
    if (!(photo instanceof File) || typeof u !== 'string' || !u) {
      return c.json({ error: 'photo and user required' }, 400);
    }
    b64 = toBase64(await photo.arrayBuffer());
    mime = photo.type === 'image/png' ? 'image/png' : 'image/jpeg';
    user = u;
    buddies = typeof b === 'string' ? b : '';
  }
  const ids = [user, ...(buddies ? buddies.split(',').map((s) => s.trim()).filter(Boolean) : [])];
  await seedProfilesIfEmpty(c.env.DB);
  const profiles: Record<string, Profile> = {};
  for (const id of ids) {
    const stored = await getProfile(c.env.DB, id);
    if (!stored) return c.json({ error: `unknown user: ${id}` }, 404);
    profiles[id] = stored.profile;
  }
  const t0 = Date.now();
  const spark = await readLabel(c.env.META_API_KEY, 'muse-spark-1.3', mime, b64);
  if (!spark) return c.json({ error: 'label read failed' }, 502);
  await trackUsage(c.env, 'meta', spark.tokens);
  if (!spark.wine?.color) return c.json({ error: 'could not read label' }, 502);
  const sparkWine = spark.wine as LabelWine;
  const producerOf = (w: LabelWine) => w.producer ?? w.winery ?? '';
  const stored = await getWine(c.env.DB, wineId(producerOf(sparkWine), sparkWine.name, sparkWine.vintage ?? null));
  let wine: LabelWine;
  let readBy: string;
  let cacheHit: number;
  let id: string;
  if (stored) {
    wine = { ...sparkWine, color: stored.color, acidity: stored.acidity, sweetness: stored.sweetness, tannin: stored.tannin, body: stored.body };
    readBy = stored.source;
    cacheHit = 1;
    id = stored.id;
    await upsertWine(c.env.DB, stored);
  } else {
    wine = sparkWine;
    readBy = 'spark';
    if ((wine.confidence ?? 1) < 0.7) {
      const wonder = await readLabel(c.env.META_API_KEY, 'muse-wonder-1.0', mime, b64);
      if (wonder) {
        await trackUsage(c.env, 'meta', wonder.tokens);
        if (wonder.wine?.color && (wonder.wine.confidence ?? 0) > (wine.confidence ?? 0)) {
          wine = wonder.wine as LabelWine;
          readBy = 'wonder';
        }
      }
    }
    id = wineId(producerOf(wine), wine.name, wine.vintage ?? null);
    const row: NewWine = {
      id, producer: producerOf(wine) || null, name: wine.name, vintage: wine.vintage ?? null,
      region: wine.region ?? null, country: wine.country ?? null,
      grapes: Array.isArray(wine.grapes) ? wine.grapes : null, abv: wine.alcohol ?? null,
      color: wine.color, acidity: wine.acidity, sweetness: wine.sweetness, tannin: wine.tannin, body: wine.body,
      source: readBy, confidence: wine.confidence ?? null,
    };
    await upsertWine(c.env.DB, row);
    cacheHit = 0;
  }
  const matches = ids.map((uid) => ({ user: uid, score: fourAxisMatch(profiles[uid], wine) }));
  const scanId = await insertScan(c.env.DB, {
    userId: user, wineId: id, score: matches[0].score, buddies: buddies || null,
    cacheHit, readBy, latencyMs: Date.now() - t0,
  });
  return c.json({ wine, matches, readBy, read_by: readBy, scan_id: scanId, cache_hit: cacheHit });
});

app.post('/explain', async (c) => {
  const { wine, profile, score, lastLoved } = await c.req.json();
  const prompt = `You are a friendly sommelier speaking to one person. Taste scale is 1-5.
User profile: ${JSON.stringify(profile)}.
Wine on the shelf: ${JSON.stringify(wine)}. Last wine they loved: ${JSON.stringify(lastLoved)}.
Compatibility score (already computed): ${score}%.
In two short sentences, tell the user whether they'd like it and why, comparing it to the wine they loved.
Refer to wines by grape and country only, never by brand. Speak about *their* taste, not about the wine's quality.`;
  const res = await fetch('https://inference.baseten.co/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${c.env.BASETEN_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'meta-models/muse-spark-open-1026',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      temperature: 0.4,
      reasoning_effort: 'low',
    }),
  });
  if (!res.ok) {
    console.error(res.status, await res.text());
    return c.json({ error: 'explanation failed' }, 502);
  }
  const data = await res.json();
  await trackUsage(c.env, 'baseten', data?.usage?.total_tokens ?? 0);
  return c.json({ text: data?.choices?.[0]?.message?.content ?? '' });
});

app.post('/transcribe', async (c) => {
  let audio: File | null = null;
  try {
    const form = await c.req.formData();
    const a = form.get('audio');
    if (a instanceof File) audio = a;
  } catch {
    audio = null;
  }
  if (!audio) return c.json({ error: 'audio required' }, 400);
  const wavBytes = await audio.arrayBuffer();
  const upstream = new FormData();
  upstream.append('request', JSON.stringify({ mode: 'PUSH_TO_TALK', model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV' }));
  upstream.append('audio', new Blob([wavBytes], { type: 'audio/wav' }), 'audio.wav');
  const url = 'https://api.meta.ai/v1/asr/transcribe';
  console.log(url);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.env.META_API_KEY}` },
      body: upstream,
    });
  } catch (e) {
    console.error(e);
    return c.json({ error: 'transcribe: fetch failed' }, 502);
  }
  if (!res.ok) {
    const excerpt = (await res.text()).slice(0, 300);
    console.error(res.status, excerpt);
    const upstream = `${res.status} ${excerpt}`.replace(/[\r\n]+/g, ' ').slice(0, 200);
    return c.json({ error: `transcribe: ${res.status} ${excerpt}` }, 502, { 'x-upstream': upstream });
  }
  const data = (await res.json()) as {
    transcript?: string;
    audioDurationMs?: number;
  };
  const seconds = Number(data?.audioDurationMs) / 1000;
  const estimated = Math.max(1, Math.round(audio.size / 32000));
  await trackUsage(c.env, 'meta', Number.isFinite(seconds) && seconds > 0 ? seconds : estimated);
  return c.json({ text: data?.transcript ?? '' });
});

app.post('/feedback', async (c) => {
  const { scan_id, verdict } = await c.req.json();
  if (verdict !== 'loved' && verdict !== 'not_for_me') {
    return c.json({ error: 'verdict must be loved or not_for_me' }, 400);
  }
  if (scan_id == null) return c.json({ error: 'scan_id required' }, 400);
  const scan = await getScan(c.env.DB, scan_id);
  if (!scan) return c.json({ error: `unknown scan: ${scan_id}` }, 404);
  const stored = await getProfile(c.env.DB, scan.userId);
  if (!stored) return c.json({ error: `unknown user: ${scan.userId}` }, 404);
  const wine = await getWine(c.env.DB, scan.wineId);
  if (!wine) return c.json({ error: `unknown wine: ${scan.wineId}` }, 404);
  const updated = applyFeedback(
    stored.profile,
    { color: wine.color, acidity: wine.acidity, sweetness: wine.sweetness, tannin: wine.tannin, body: wine.body },
    verdict,
  );
  await saveProfile(c.env.DB, scan.userId, stored.displayName, updated);
  await setScanFeedback(c.env.DB, scan.id, verdict);
  return c.json(updated);
});

app.post('/reset', async (c) => {
  await resetDemo(c.env.DB);
  return c.json({ ok: true });
});

app.get('/usage', async (c) => {
  const day = new Date().toISOString().slice(0, 10);
  const [meta, baseten] = await Promise.all([
    c.env.USAGE.get(`usage:${day}:meta`),
    c.env.USAGE.get(`usage:${day}:baseten`),
  ]);
  const stats = await scanStats(c.env.DB, day);
  return c.json({ date: day, meta: Number(meta ?? 0), baseten: Number(baseten ?? 0), scans: stats.scans, cache_hits: stats.cacheHits });
});

export default app;
