import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { applyFeedback, effectiveProfile, fourAxisMatch, learningStep, type Axes, type Color, type Profile } from './fourAxisMatch';
import {
  getEffectiveAxes, getProfile, getScan, getWine, insertScan, resetDemo, saveProfile, scanStats,
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
  BASETEN_API_KEY?: string;
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

const EXPLAIN_SYSTEM =
  'The match score is already computed and is final. Write exactly two sentences in plain English for a shopper. ' +
  'Sentence 1 states the verdict consistent with the score (never contradict it). ' +
  'Sentence 2 names the one axis that most explains the score: if score >= 60, the axis closest to the profile; ' +
  "if < 60, the axis furthest from it. Do not mention numbers or the word 'axis'. Do not recommend other wines.";

const EXPLAIN_AXES: (keyof Axes)[] = ['acidity', 'sweetness', 'tannin', 'body'];

// Preferred axis when |delta| values are within 0.25 of each other.
const AXIS_PRIORITY: (keyof Axes)[] = ['tannin', 'acidity', 'body', 'sweetness'];

function selectAxis(d: Axes, want: 'largest' | 'smallest'): { axis: keyof Axes; delta: number } {
  let extreme = want === 'largest' ? -Infinity : Infinity;
  for (const k of EXPLAIN_AXES) {
    const a = Math.abs(d[k]);
    extreme = want === 'largest' ? Math.max(extreme, a) : Math.min(extreme, a);
  }
  let best: keyof Axes = EXPLAIN_AXES[0];
  for (const k of AXIS_PRIORITY) {
    if (Math.abs(Math.abs(d[k]) - extreme) <= 0.25) {
      best = k;
      break;
    }
  }
  return { axis: best, delta: d[best] };
}

type Magnitude = 'slightly' | 'noticeably' | 'much';

function magnitudeFor(absDelta: number): Magnitude {
  if (absDelta < 0.75) return 'slightly';
  if (absDelta < 1.5) return 'noticeably';
  return 'much';
}

type AxisPick = { axis: keyof Axes; delta: number; magnitude: Magnitude; direction: 'higher' | 'lower' };
type ClosePick = { axis: keyof Axes; relation: 'close match' };

function annotatePick(sel: { axis: keyof Axes; delta: number }): AxisPick {
  return {
    ...sel,
    magnitude: magnitudeFor(Math.abs(sel.delta)),
    direction: sel.delta >= 0 ? 'higher' : 'lower',
  };
}

function axisValue(o: unknown, k: keyof Axes): number {
  const v = Number((o as Record<string, unknown> | null | undefined)?.[k]);
  return Number.isFinite(v) ? v : 3;
}

type VerdictLabel = 'strong match' | 'likely match' | 'mixed' | 'unlikely match';

function verdictFor(score: number): VerdictLabel {
  if (score >= 80) return 'strong match';
  if (score >= 60) return 'likely match';
  if (score >= 40) return 'mixed';
  return 'unlikely match';
}

type ExplainFacts = {
  score: number;
  verdict: VerdictLabel;
  profile: Axes;
  wine: Axes;
  delta: Axes;
  picked: ClosePick | AxisPick;
  grapes: string[];
  country: string;
};

function explainFacts(wine: unknown, profile: unknown, score: unknown): ExplainFacts {
  const raw = Number(score);
  const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 50;
  const p = {} as Axes;
  const w = {} as Axes;
  const d = {} as Axes;
  for (const k of EXPLAIN_AXES) {
    p[k] = axisValue(profile, k);
    w[k] = axisValue(wine, k);
    d[k] = w[k] - p[k];
  }
  const furthest = selectAxis(d, 'largest');
  const closest = selectAxis(d, 'smallest');
  const picked: ClosePick | AxisPick =
    clamped >= 60 ? { axis: closest.axis, relation: 'close match' } : annotatePick(furthest);
  const rec = (wine ?? {}) as { grapes?: unknown; country?: unknown };
  return {
    score: clamped,
    verdict: verdictFor(clamped),
    profile: p,
    wine: w,
    delta: d,
    picked,
    grapes: Array.isArray(rec.grapes) ? rec.grapes.filter((g): g is string => typeof g === 'string') : [],
    country: typeof rec.country === 'string' ? rec.country : '',
  };
}

function explainUserMessage(f: ExplainFacts, lastLoved: unknown): string {
  const facts: Record<string, unknown> = {
    score: f.score,
    verdict: f.verdict,
    profile: f.profile,
    wine: f.wine,
    delta_wine_minus_profile: f.delta,
    picked: f.picked,
    grapes: f.grapes,
    country: f.country,
  };
  let tail = 'Refer to wines by grape and country only, never by brand';
  if (lastLoved != null) {
    const rec = lastLoved as { grape?: unknown; country?: unknown };
    facts.last_loved = {
      grape: typeof rec.grape === 'string' ? rec.grape : '',
      country: typeof rec.country === 'string' ? rec.country : '',
    };
    tail += '; you may mention the wine the user last loved in sentence 2, by grape and country only, never by brand';
  }
  tail +=
    f.score >= 60
      ? '; sentence 2 says this axis is close to what the user enjoys.'
      : '; describe the degree with the given magnitude word; do not invent your own degree words.';
  return (
    'The match below was already computed and is final. All taste values are 1-5.\n\n' +
    JSON.stringify(facts) +
    '\n\n' +
    tail +
    ' Write the two sentences.'
  );
}

const FIRST_SENTENCE: Record<VerdictLabel, string> = {
  'strong match': "You'll love this one — it's a strong match for your taste.",
  'likely match': "You'll probably enjoy this one — it's a likely match for your taste.",
  mixed: "You might enjoy this one — it's a mixed match for your taste.",
  'unlikely match': "You likely won't enjoy this one — it's an unlikely match for you.",
};

function templateExplanation(f: ExplainFacts): string {
  const pick = f.picked;
  if ('relation' in pick) {
    return `${FIRST_SENTENCE[f.verdict]} Its ${pick.axis} is close to what you enjoy.`;
  }
  return `${FIRST_SENTENCE[f.verdict]} Its ${pick.axis} is ${pick.magnitude} ${pick.direction} than your usual taste.`;
}

function explainDebug(f: ExplainFacts) {
  const magnitude = 'magnitude' in f.picked ? f.picked.magnitude : null;
  const direction = 'direction' in f.picked ? f.picked.direction : null;
  return {
    wine_axes: f.wine,
    profile_axes: f.profile,
    deltas: f.delta,
    picked_axis: f.picked.axis,
    magnitude,
    direction,
    score: f.score,
    label: f.verdict,
  };
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
  // Reuse the explain facts machinery so scan debug matches explain debug semantics.
  const scoreFacts = explainFacts(
    { acidity: wine.acidity, sweetness: wine.sweetness, tannin: wine.tannin, body: wine.body },
    effectiveProfile(profiles[user], wine.color),
    matches[0].score,
  );
  const scoreDebug = explainDebug(scoreFacts);
  return c.json({
    wine, matches, readBy, read_by: readBy, scan_id: scanId, cache_hit: cacheHit,
    debug: {
      scan_id: scanId,
      wine_axes_used_for_score: scoreDebug.wine_axes,
      profile_axes_before: scoreDebug.profile_axes,
      deltas: scoreDebug.deltas,
      picked_axis: scoreDebug.picked_axis,
      magnitude: scoreDebug.magnitude,
      direction: scoreDebug.direction,
      score: scoreDebug.score,
      label: scoreDebug.label,
    },
  });
});

app.post('/explain', async (c) => {
  const { wine, score, lastLoved, user } = await c.req.json();
  if (typeof user !== 'string' || !user) return c.json({ error: 'user required' }, 400);
  const color = (wine as { color?: unknown })?.color;
  if (color !== 'red' && color !== 'white' && color !== 'rose' && color !== 'sparkling') {
    return c.json({ error: 'wine color required' }, 400);
  }
  await seedProfilesIfEmpty(c.env.DB);
  const axes = await getEffectiveAxes(c.env.DB, user, color as Color);
  if (!axes) return c.json({ error: `unknown user: ${user}` }, 404);
  const facts = explainFacts(wine, axes, score);
  if (!c.env.BASETEN_API_KEY) {
    console.warn('BASETEN_API_KEY is not set; using the local explanation template');
    return c.json({ text: templateExplanation(facts), explained_by: 'template', debug: explainDebug(facts) });
  }
  const res = await fetch('https://inference.baseten.co/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${c.env.BASETEN_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'meta-models/muse-spark-open-1026',
      messages: [
        { role: 'system', content: EXPLAIN_SYSTEM },
        { role: 'user', content: explainUserMessage(facts, lastLoved) },
      ],
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
  return c.json({ text: data?.choices?.[0]?.message?.content ?? '', explained_by: 'spark-open-baseten', debug: explainDebug(facts) });
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
  const overlayKey = wine.color === 'sparkling' ? 'white' : wine.color;
  const beforeAxes = { ...stored.profile[overlayKey].axes };
  const nBefore = stored.profile[overlayKey].n;
  const updated = applyFeedback(
    stored.profile,
    { color: wine.color, acidity: wine.acidity, sweetness: wine.sweetness, tannin: wine.tannin, body: wine.body },
    verdict,
  );
  await saveProfile(c.env.DB, scan.userId, stored.displayName, updated);
  await setScanFeedback(c.env.DB, scan.id, verdict);
  return c.json({
    ...updated,
    debug: {
      scan_id: scan.id,
      wine_axes_used_for_update: { acidity: wine.acidity, sweetness: wine.sweetness, tannin: wine.tannin, body: wine.body },
      profile_before: beforeAxes,
      profile_after: { ...updated[overlayKey].axes },
      step: learningStep(nBefore),
      n: nBefore,
    },
  });
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
