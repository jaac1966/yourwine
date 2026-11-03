import './style.css';

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_URL?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

const API_URL = (import.meta.env.VITE_API_URL || 'https://api.yourwine.net').replace(/\/$/, '');
const USER = 'alex';
// NOTE: the api parses buddies with .split(','), so this stays a comma string
// (sending ["ana","luis"] as JSON would 500 in the /scan handler).
const BUDDIES = 'ana,luis';

type Axes = { acidity: number; sweetness: number; tannin: number; body: number };
type Overlay = { axes: Axes; n: number };
type Profile = { base: Axes; red: Overlay; white: Overlay; rose: Overlay };
type Color = 'red' | 'white' | 'rose' | 'sparkling';
type Wine = { name: string; vintage: number | null; color: Color };
type Match = { user: string; score: number };
type ScanDebug = {
  scan_id: number;
  wine_axes_used_for_score: Axes;
  profile_axes_before: Axes;
  deltas: Axes;
  picked_axis: string;
  magnitude: string | null;
  direction: string | null;
  score: number;
  label: string;
};
type FeedbackDebug = {
  scan_id: number;
  wine_axes_used_for_update: Axes;
  profile_before: Axes;
  profile_after: Axes;
  step: number;
  n: number;
};
type ScanResp = {
  wine: Wine;
  matches: Match[];
  read_by?: string;
  readBy?: string;
  scan_id: number;
  cache_hit: number;
  debug: ScanDebug;
};
type ExplainDebug = {
  wine_axes: Axes;
  profile_axes: Axes;
  deltas: Axes;
  picked_axis: string;
  magnitude: string | null;
  direction: string | null;
  score: number;
  label: string;
};
type ExplainResp = { text: string; explained_by: string; debug: ExplainDebug };

const AXES = ['acidity', 'sweetness', 'tannin', 'body'] as const;

// Keep in sync with api/src/fourAxisMatch.ts.
function effectiveProfile(profile: Profile, color: Color): Axes {
  const overlay = color === 'sparkling' ? profile.white : profile[color];
  return { ...overlay.axes };
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API_URL + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      const data = JSON.parse(text) as { error?: unknown; finish_reason?: unknown };
      if (typeof data.error === 'string') {
        detail = data.error + (typeof data.finish_reason === 'string' ? ` (${data.finish_reason})` : '');
      }
    } catch {
      /* keep raw excerpt */
    }
    throw new Error(`${res.status} ${path}: ${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function resizePhoto(file: File, maxSide = 1024): Promise<{ b64: string; mime: string }> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.85);
    return { b64: url.split(',')[1] ?? '', mime: 'image/jpeg' };
  } finally {
    bitmap.close();
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Keep in sync with the api verdict labels.
function verdictLabel(score: number): 'strong match' | 'likely match' | 'mixed' | 'unlikely match' {
  if (score >= 80) return 'strong match';
  if (score >= 60) return 'likely match';
  if (score >= 40) return 'mixed';
  return 'unlikely match';
}

const CHIP_CLASS: Record<ReturnType<typeof verdictLabel>, string> = {
  'strong match': 'chip-green',
  'likely match': 'chip-olive',
  mixed: 'chip-amber',
  'unlikely match': 'chip-grey',
};

let busy = false;
let lastPhoto: { b64: string; mime: string } | null = null;
let lastScan: ScanResp | null = null;

const photoInput = el<HTMLInputElement>('photo');
const preview = el<HTMLImageElement>('preview');
const status = el('status');
const results = el('results');
const wineName = el('wineName');
const myScore = el('myScore');
const verdictChip = el('verdictChip');
const buddyScores = el('buddyScores');
const scanMeta = el('scanMeta');
const scanDebug = el('scanDebug');
const explStatus = el('explStatus');
const explText = el('explText');
const explMeta = el('explMeta');
const explDebug = el('explDebug');
const feedback = el('feedback');
const fbMsg = el('fbMsg');
const bars = el('bars');
const fbDebug = el('fbDebug');
const againBtn = el<HTMLButtonElement>('again');
const resetMsg = el('resetMsg');

el('debugBlock').hidden = new URLSearchParams(location.search).get('debug') !== '1';

function setBusy(b: boolean) {
  busy = b;
  for (const id of ['loved', 'meh', 'again', 'reset']) el<HTMLButtonElement>(id).disabled = b;
}

async function scanAndExplain(photo: { b64: string; mime: string }) {
  if (busy) return;
  setBusy(true);
  results.hidden = true;
  feedback.hidden = true;
  explText.textContent = '';
  explMeta.textContent = '';
  explDebug.textContent = '';
  fbMsg.textContent = '';
  clearBars();
  scanDebug.textContent = '';
  fbDebug.textContent = '';
  try {
    status.textContent = 'Reading label…';
    const scan = await post<ScanResp>('/scan', {
      photo_b64: photo.b64,
      mime: photo.mime,
      user: USER,
      buddies: BUDDIES,
    });
    lastScan = scan;
    renderScan(scan);
    status.textContent = '';
  } catch (e) {
    status.textContent = `Scan failed: ${message(e)}`;
    setBusy(false);
    return;
  }
  try {
    explStatus.textContent = 'Explaining…';
    const me = lastScan.matches.find((m) => m.user === USER) ?? lastScan.matches[0];
    const exp = await post<ExplainResp>('/explain', {
      wine: lastScan.wine,
      score: me.score,
      user: USER,
      lastLoved: { grape: 'Zinfandel', country: 'USA' },
    });
    explStatus.textContent = '';
    explText.textContent = exp.text;
    explMeta.textContent = `explained_by ${exp.explained_by}`;
    explDebug.textContent = JSON.stringify(exp.debug, null, 1);
  } catch (e) {
    explStatus.textContent = '';
    explText.textContent = `Explanation failed: ${message(e)}`;
  } finally {
    setBusy(false);
  }
}

function renderScan(scan: ScanResp) {
  wineName.textContent = `${scan.wine.name} · ${scan.wine.vintage ?? 'NV'}`;
  const me = scan.matches.find((m) => m.user === USER) ?? scan.matches[0];
  myScore.replaceChildren();
  const pct = document.createElement('span');
  pct.className = 'pct';
  pct.textContent = `${me.score}%`;
  const forYou = document.createElement('span');
  forYou.className = 'foryou';
  forYou.textContent = ' for you';
  myScore.append(pct, forYou);
  const label = verdictLabel(me.score);
  verdictChip.textContent = label;
  verdictChip.className = `chip ${CHIP_CLASS[label]}`;
  buddyScores.replaceChildren();
  for (const m of scan.matches.filter((m) => m.user !== USER)) {
    const chip = document.createElement('span');
    chip.className = 'chip chip-buddy';
    chip.textContent = `${cap(m.user)} ${m.score}%`;
    buddyScores.appendChild(chip);
  }
  scanMeta.textContent = `read_by ${scan.read_by ?? scan.readBy ?? '?'} · cache_hit ${scan.cache_hit}`;
  scanDebug.textContent = JSON.stringify(scan.debug, null, 1);
  results.hidden = false;
  feedback.hidden = false;
  againBtn.hidden = false;
}

const barFills: HTMLDivElement[] = [];
const barNums: HTMLSpanElement[] = [];

function clearBars() {
  bars.replaceChildren();
  barFills.length = 0;
  barNums.length = 0;
}

function renderBars(eff: Axes) {
  if (barFills.length === 0) {
    for (const k of AXES) {
      const row = document.createElement('div');
      row.className = 'bar-row';
      const label = document.createElement('span');
      label.className = 'bar-label';
      label.textContent = k;
      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      fill.style.width = '0%';
      track.appendChild(fill);
      const num = document.createElement('span');
      num.className = 'bar-num';
      row.append(label, track, num);
      bars.appendChild(row);
      barFills.push(fill);
      barNums.push(num);
    }
    void bars.offsetWidth;
  }
  AXES.forEach((k, i) => {
    barFills[i].style.width = `${Math.max(3, ((eff[k] - 1) / 4) * 100)}%`;
    barNums[i].textContent = String(Math.round(eff[k] * 10) / 10);
  });
}

async function sendFeedback(verdict: 'loved' | 'not_for_me') {
  if (busy || !lastScan) return;
  setBusy(true);
  fbMsg.textContent = 'Saving…';
  try {
    const profile = await post<Profile & { debug: FeedbackDebug }>('/feedback', { scan_id: lastScan.scan_id, verdict });
    const color = lastScan.wine.color === 'sparkling' ? 'white' : lastScan.wine.color;
    fbMsg.textContent = `Got it — your ${color} profile moved`;
    renderBars(effectiveProfile(profile, lastScan.wine.color));
    fbDebug.textContent = JSON.stringify(profile.debug, null, 1);
  } catch (e) {
    fbMsg.textContent = `Feedback failed: ${message(e)}`;
  } finally {
    setBusy(false);
  }
}

photoInput.addEventListener('change', async () => {
  const file = photoInput.files?.[0];
  if (!file || busy) return;
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  try {
    status.textContent = 'Resizing…';
    lastPhoto = await resizePhoto(file);
  } catch (e) {
    status.textContent = `Could not read photo: ${message(e)}`;
    return;
  }
  await scanAndExplain(lastPhoto);
  photoInput.value = '';
});

el<HTMLButtonElement>('loved').addEventListener('click', () => void sendFeedback('loved'));
el<HTMLButtonElement>('meh').addEventListener('click', () => void sendFeedback('not_for_me'));
againBtn.addEventListener('click', () => {
  if (lastPhoto) void scanAndExplain(lastPhoto);
});
el<HTMLButtonElement>('reset').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    await post('/reset', {});
    resetMsg.textContent = 'Demo reset.';
  } catch (e) {
    resetMsg.textContent = `Reset failed: ${message(e)}`;
  } finally {
    setBusy(false);
  }
});
