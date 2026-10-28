const key = process.env.BASETEN_API_KEY;
if (!key) throw new Error('BASETEN_API_KEY missing (see .env.example)');

const MODEL = 'meta-models/muse-spark-open-1026';

const profile = { acidity: 2, sweetness: 4, tannin: 2, body: 3 };
const wine = { grape: 'Malbec', country: 'Argentina', acidity: 3, sweetness: 2, tannin: 3, body: 4 };
const lastLoved = { grape: 'Zinfandel', country: 'USA' };

const prompt = `You are a friendly sommelier speaking to one person. Taste scale is 1-5.
User profile: ${JSON.stringify(profile)}.
Wine on the shelf: ${JSON.stringify(wine)}. Last wine they loved: ${JSON.stringify(lastLoved)}.
Compatibility score (already computed): 78%.
In two short sentences, tell the user whether they'd like it and why, comparing it to the wine they loved.
Refer to wines by grape and country only, never by brand. Speak about *their* taste, not about the wine's quality.`;

const t0 = performance.now();
const res = await fetch('https://inference.baseten.co/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2000,
    temperature: 0.4,
    reasoning_effort: process.env.REASONING ?? 'low',
  }),
});
const ms = Math.round(performance.now() - t0);

if (!res.ok) {
  console.error(res.status, await res.text());
  process.exit(1);
}
const data = await res.json();
const msg = data.choices?.[0]?.message ?? {};
console.log(`${MODEL} · ${ms} ms`);
console.log('usage:', data.usage);
if (msg.reasoning_content) console.log(`(reasoning: ${msg.reasoning_content.length} chars, not shown)`);
console.log(msg.content ?? ('(no content, finish_reason=' + data.choices?.[0]?.finish_reason + ')'));
