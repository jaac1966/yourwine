import { readFile } from 'node:fs/promises';

const key = process.env.META_API_KEY;
if (!key) throw new Error('META_API_KEY missing (see .env.example)');

const wavPath = process.argv[2];

function toneWav() {
  const rate = 16000;
  const pcm = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i++) {
    pcm.writeInt16LE(Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const wav = wavPath ? await readFile(wavPath) : toneWav();

async function post(url) {
  const form = new FormData();
  form.set('request', JSON.stringify({ mode: 'PUSH_TO_TALK', model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV' }));
  form.set('audio', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  const ms = Math.round(performance.now() - t0);
  const body = await res.text();
  console.log(`\nPOST ${url} · ${res.status} · ${ms} ms`);
  console.log('headers:');
  for (const [k, v] of res.headers) console.log(`  ${k}: ${v}`);
  console.log('body:');
  console.log(body);
}

await post('https://api.meta.ai/v1/asr/transcribe');
await post('https://api.meta.ai/v1/asr/transcribe?sessionId=smoke-1');
