export type Axes = { acidity: number; sweetness: number; tannin: number; body: number };
export type Color = 'red' | 'white' | 'rose' | 'sparkling';
export type Overlay = { axes: Axes; n: number };
// Overlays start as copies of base with n: 0; feedback then moves them.
export type Profile = { base: Axes; red: Overlay; white: Overlay; rose: Overlay };
export type Wine = Axes & { color: Color };
export type Verdict = 'loved' | 'not_for_me';

const AXES = ['acidity', 'sweetness', 'tannin', 'body'] as const;

const WEIGHTS: Record<Color, Axes> = {
  red: { acidity: 1, sweetness: 1, tannin: 1, body: 1 },
  rose: { acidity: 1.2, sweetness: 1.2, tannin: 0.3, body: 0.8 },
  white: { acidity: 1.3, sweetness: 1.2, tannin: 0.1, body: 0.8 },
  sparkling: { acidity: 1.3, sweetness: 1.2, tannin: 0.1, body: 0.8 },
};

// Sparkling has no overlay of its own, so it shares white's.
function overlayFor(profile: Profile, color: Color): Overlay {
  return color === 'sparkling' ? profile.white : profile[color];
}

function effectiveProfile(profile: Profile, color: Color): Axes {
  const overlay = overlayFor(profile, color);
  const t = Math.min(overlay.n / 5, 1);
  const eff = {} as Axes;
  for (const k of AXES) eff[k] = profile.base[k] + (overlay.axes[k] - profile.base[k]) * t;
  return eff;
}

export function fourAxisMatch(profile: Profile, wine: Wine): number {
  const w = WEIGHTS[wine.color];
  const eff = effectiveProfile(profile, wine.color);
  let diff = 0;
  let total = 0;
  for (const k of AXES) {
    diff += (w[k] * Math.abs(eff[k] - wine[k])) / 4;
    total += w[k];
  }
  return Math.round(100 * (1 - diff / total));
}

export function applyFeedback(profile: Profile, wine: Wine, verdict: Verdict): Profile {
  const overlay = overlayFor(profile, wine.color);
  const dir = verdict === 'loved' ? 1 : -1;
  for (const k of AXES) {
    const d = wine[k] - overlay.axes[k];
    if (d !== 0) overlay.axes[k] = Math.min(5, Math.max(1, overlay.axes[k] + dir * Math.sign(d) * 0.5));
  }
  overlay.n += 1;
  return profile;
}
