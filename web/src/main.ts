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
type ProfileResp = { user: string; color: string; axes: Axes };

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_URL + path, init);
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

async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get<T>(path: string): Promise<T> {
  return request<T>(path);
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
  'strong match': 'ok',
  'likely match': 'ok',
  mixed: 'warn',
  'unlikely match': 'bad',
};

const AXIS_META: Record<(typeof AXES)[number], { name: string; sub: string }> = {
  acidity: { name: 'Acidity', sub: 'Soft → Tart' },
  sweetness: { name: 'Sweetness', sub: 'Dry → Sweet' },
  tannin: { name: 'Tannins', sub: 'Smooth → Grippy' },
  body: { name: 'Body', sub: 'Light → Full' },
};

const AVATAR_COLORS = ['#B45A7E', '#4C6FB1'];

let busy = false;
let lastScan: ScanResp | null = null;
let profileColor: Color = 'red';
let lastPhoto: { b64: string; mime: string } | null = null;

const scanBtn = el<HTMLButtonElement>('scan');
const photoInput = el<HTMLInputElement>('photo');
const photoCard = el('photoCard');
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
const avatars = el('avatars');
const profileCard = el('profile');
const profileTitle = el('profileTitle');
const fbDebug = el('fbDebug');
const againBtn = el<HTMLButtonElement>('again');
const resetMsg = el('resetMsg');
const progress = el('progress');
const verdictError = el('verdictError');
const tryAgain = el<HTMLButtonElement>('tryAgain');
const buddiesBlock = el('buddiesBlock');
const profileStatus = el('profileStatus');

el('debugBlock').hidden = new URLSearchParams(location.search).get('debug') !== '1';

function setBusy(b: boolean) {
  busy = b;
  for (const id of ['scan', 'loved', 'meh', 'reset']) el<HTMLButtonElement>(id).disabled = b;
}

function showVerdictError(msg: string) {
  progress.hidden = true;
  explStatus.textContent = '';
  verdictError.textContent = msg;
  tryAgain.hidden = false;
}

function clearVerdictError() {
  verdictError.textContent = '';
  tryAgain.hidden = true;
}

async function scanAndExplain(photo: { b64: string; mime: string }) {
  if (busy) return;
  setBusy(true);
  results.hidden = false;
  feedback.hidden = true;
  clearVerdictError();
  wineName.textContent = '';
  myScore.replaceChildren();
  verdictChip.textContent = '';
  verdictChip.className = 'chip';
  buddyScores.textContent = '';
  avatars.replaceChildren();
  buddiesBlock.hidden = true;
  explText.textContent = '';
  explMeta.textContent = '';
  explDebug.textContent = '';
  fbMsg.textContent = '';
  scanMeta.textContent = '';
  scanDebug.textContent = '';
  fbDebug.textContent = '';
  progress.hidden = false;
  try {
    explStatus.textContent = 'Reading the label with Muse Spark…';
    const scan = await post<ScanResp>('/scan', {
      photo_b64: photo.b64,
      mime: photo.mime,
      user: USER,
      buddies: BUDDIES,
    });
    lastScan = scan;
    renderScan(scan);
  } catch (e) {
    showVerdictError(`Scan failed: ${message(e)}`);
    setBusy(false);
    return;
  }
  try {
    explStatus.textContent = 'Writing the explanation with Muse Spark Open…';
    const me = lastScan.matches.find((m) => m.user === USER) ?? lastScan.matches[0];
    const exp = await post<ExplainResp>('/explain', {
      wine: lastScan.wine,
      score: me.score,
      user: USER,
      lastLoved: { grape: 'Zinfandel', country: 'USA' },
    });
    progress.hidden = true;
    explStatus.textContent = '';
    explText.textContent = exp.text;
    explMeta.textContent = `explained_by ${exp.explained_by}`;
    explDebug.textContent = JSON.stringify(exp.debug);
  } catch (e) {
    showVerdictError(`Explanation failed: ${message(e)}`);
  } finally {
    setBusy(false);
  }
}

function renderScan(scan: ScanResp) {
  wineName.textContent = `${scan.wine.name} · ${scan.wine.vintage ?? 'NV'}`;
  const me = scan.matches.find((m) => m.user === USER) ?? scan.matches[0];
  myScore.replaceChildren();
  const pct = document.createElement('b');
  pct.textContent = `${me.score}%`;
  const forYou = document.createElement('span');
  forYou.textContent = 'for you';
  myScore.append(pct, forYou);
  const label = verdictLabel(me.score);
  verdictChip.textContent = label.charAt(0).toUpperCase() + label.slice(1);
  verdictChip.className = `chip ${CHIP_CLASS[label]}`;
  const buddies = scan.matches.filter((m) => m.user !== USER);
  buddyScores.textContent = buddies.map((m) => `${cap(m.user)} ${m.score}%`).join(' · ');
  buddiesBlock.hidden = buddies.length === 0;
  avatars.replaceChildren();
  buddies.forEach((m, i) => {
    const av = document.createElement('span');
    av.className = 'av';
    av.style.background = AVATAR_COLORS[i % AVATAR_COLORS.length];
    av.textContent = m.user.charAt(0).toUpperCase();
    avatars.appendChild(av);
  });
  scanMeta.textContent = `read_by ${scan.read_by ?? scan.readBy ?? '?'} · cache_hit ${scan.cache_hit}`;
  scanDebug.textContent = JSON.stringify(scan.debug);
  results.hidden = false;
  feedback.hidden = false;
  againBtn.hidden = false;
}

type BarRefs = { segs: HTMLElement[]; v: HTMLSpanElement };
const barRefs = new Map<(typeof AXES)[number], BarRefs>();

function segFill(v: number, i: number): string {
  const full = Math.floor(v);
  if (i < full) return '100%';
  if (i === full) return `${Math.round((v - full) * 100)}%`;
  return '0%';
}

function renderBars(eff: Axes) {
  if (barRefs.size === 0) {
    for (const k of AXES) {
      const meta = AXIS_META[k];
      const row = document.createElement('div');
      row.className = 'axis';
      const head = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = meta.name;
      const sub = document.createElement('small');
      sub.textContent = meta.sub;
      head.append(name, sub);
      const seg = document.createElement('div');
      seg.className = 'seg';
      const segs: HTMLElement[] = [];
      for (let i = 0; i < 5; i++) {
        const s = document.createElement('i');
        s.style.setProperty('--f', '0%');
        seg.appendChild(s);
        segs.push(s);
      }
      const num = document.createElement('span');
      num.className = 'v';
      row.append(head, seg, num);
      bars.appendChild(row);
      barRefs.set(k, { segs, v: num });
    }
    void bars.offsetWidth;
  }
  for (const k of AXES) {
    const refs = barRefs.get(k);
    if (!refs) continue;
    refs.segs.forEach((s, i) => s.style.setProperty('--f', segFill(eff[k], i)));
    refs.v.textContent = eff[k].toFixed(1);
  }
}

async function loadProfile(color: Color) {
  profileColor = color;
  const data = await get<ProfileResp>(`/profile?user=${USER}&color=${color}`);
  profileTitle.textContent = `My profile · ${data.color === 'sparkling' ? 'white' : data.color}`;
  renderBars(data.axes);
}

async function sendFeedback(verdict: 'loved' | 'not_for_me') {
  if (busy || !lastScan) return;
  setBusy(true);
  profileStatus.textContent = 'Updating your profile…';
  try {
    const profile = await post<Profile & { debug: FeedbackDebug }>('/feedback', { scan_id: lastScan.scan_id, verdict });
    const color = lastScan.wine.color === 'sparkling' ? 'white' : lastScan.wine.color;
    fbMsg.textContent = `Got it — your ${color} profile moved`;
    profileColor = color;
    profileTitle.textContent = `My profile · ${color}`;
    profileCard.hidden = false;
    renderBars(effectiveProfile(profile, lastScan.wine.color));
    profileStatus.textContent = '';
    fbDebug.textContent = JSON.stringify(profile.debug);
  } catch (e) {
    profileStatus.textContent = '';
    fbMsg.textContent = `Feedback failed: ${message(e)}`;
  } finally {
    setBusy(false);
  }
}

scanBtn.addEventListener('click', () => {
  if (!busy) photoInput.click();
});

photoInput.addEventListener('change', async () => {
  const file = photoInput.files?.[0];
  if (!file || busy) return;
  preview.src = URL.createObjectURL(file);
  photoCard.hidden = false;
  let photo: { b64: string; mime: string };
  try {
    status.textContent = 'Resizing…';
    photo = await resizePhoto(file);
    lastPhoto = photo;
  } catch (e) {
    status.textContent = `Could not read photo: ${message(e)}`;
    return;
  }
  status.textContent = '';
  await scanAndExplain(photo);
  photoInput.value = '';
});

el<HTMLButtonElement>('loved').addEventListener('click', () => void sendFeedback('loved'));
el<HTMLButtonElement>('meh').addEventListener('click', () => void sendFeedback('not_for_me'));
againBtn.addEventListener('click', () => {
  if (!busy) photoInput.click();
});
tryAgain.addEventListener('click', () => {
  if (lastPhoto && !busy) void scanAndExplain(lastPhoto);
});
el<HTMLButtonElement>('reset').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    await post('/reset', {});
    resetMsg.textContent = 'Demo reset.';
  } catch (e) {
    resetMsg.textContent = `Reset failed: ${message(e)}`;
    return;
  } finally {
    setBusy(false);
  }
  try {
    await loadProfile(profileColor);
  } catch (e) {
    resetMsg.textContent = `Could not reload profile: ${message(e)}`;
  }
});

loadProfile('red').catch((e) => {
  status.textContent = `Could not load profile: ${message(e)}`;
});
