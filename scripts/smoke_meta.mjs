import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const key = process.env.META_API_KEY;
if (!key) throw new Error('META_API_KEY missing (see .env.example)');

const photo = process.argv[2];
const model = process.argv[3] ?? 'muse-spark-1.3';

const schema = {
  name: 'wine_label',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      winery: { type: 'string' },
      country: { type: 'string' },
      region: { type: 'string' },
      grapes: { type: 'array', items: { type: 'string' } },
      vintage: { type: ['integer', 'null'] },
      alcohol: { type: ['number', 'null'] },
      confidence: { type: 'number' },
    },
    required: ['name', 'country', 'confidence'],
  },
};

const content = [{ type: 'text', text: 'Read this wine label. Return only the JSON.' }];
if (photo) {
  const mime = extname(photo) === '.png' ? 'image/png' : 'image/jpeg';
  const b64 = (await readFile(photo)).toString('base64');
  content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
} else {
  content[0].text = 'Reply with JSON for a fictional wine label: "Viña del Sur Malbec 2022, Mendoza, Argentina, 13.5%". Return only the JSON.';
}

const t0 = performance.now();
const res = await fetch('https://api.meta.ai/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_schema', json_schema: schema },
    max_output_tokens: 400,
  }),
});
const ms = Math.round(performance.now() - t0);

if (!res.ok) {
  console.error(res.status, await res.text());
  process.exit(1);
}
const data = await res.json();
console.log(`${model} · ${ms} ms`);
console.log('usage:', data.usage);
console.log(data.choices?.[0]?.message?.content);
