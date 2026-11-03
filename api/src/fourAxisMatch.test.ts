import { describe, expect, it } from 'vitest';
import { applyFeedback, fourAxisMatch, learningStep, type Axes, type Profile } from './fourAxisMatch';

const axes = (acidity: number, sweetness: number, tannin: number, body: number): Axes => ({
  acidity,
  sweetness,
  tannin,
  body,
});

function profile(base: Axes, whiteAxes: Axes = base, whiteN = 0): Profile {
  const overlay = (a: Axes, n: number) => ({ axes: { ...a }, n });
  return {
    base: { ...base },
    red: overlay(base, 0),
    white: overlay(whiteAxes, whiteN),
    rose: overlay(base, 0),
  };
}

describe('fourAxisMatch', () => {
  it('scores 100 when profile and wine are identical', () => {
    const p = profile(axes(3, 2, 4, 3));
    expect(fourAxisMatch(p, { ...axes(3, 2, 4, 3), color: 'red' })).toBe(100);
  });

  it('ignores tannin almost entirely for white wines', () => {
    const p = profile(axes(3, 3, 3, 3));
    const wine = axes(3, 3, 5, 3);
    const white = fourAxisMatch(p, { ...wine, color: 'white' });
    const red = fourAxisMatch(p, { ...wine, color: 'red' });
    expect(white).toBeGreaterThanOrEqual(98);
    expect(red).toBeLessThanOrEqual(90);
    expect(white).toBeGreaterThan(red);
  });

  it('scores against the overlay axes, ignoring base', () => {
    const p = profile(axes(3, 3, 3, 3), axes(1, 1, 1, 1), 0);
    expect(fourAxisMatch(p, { ...axes(3, 3, 3, 3), color: 'white' })).toBe(50);
  });

  it('scores against the overlay regardless of n', () => {
    const fresh = profile(axes(3, 3, 3, 3), axes(1, 1, 1, 1), 0);
    const seasoned = profile(axes(3, 3, 3, 3), axes(1, 1, 1, 1), 10);
    expect(fourAxisMatch(fresh, { ...axes(3, 3, 3, 3), color: 'white' })).toBe(50);
    expect(fourAxisMatch(seasoned, { ...axes(3, 3, 3, 3), color: 'white' })).toBe(50);
  });
});

const expectAxesCloseTo = (got: Axes, want: Axes) => {
  for (const k of ['acidity', 'sweetness', 'tannin', 'body'] as const) {
    expect(got[k]).toBeCloseTo(want[k], 8);
  }
};

describe('learningStep', () => {
  it('starts at 0.45, decays, and never goes below 0.15', () => {
    expect(learningStep(0)).toBeCloseTo(0.45, 8);
    expect(learningStep(4)).toBeCloseTo(0.15, 8);
    expect(learningStep(100)).toBe(0.15);
  });
});

describe('applyFeedback', () => {
  it('moves 45% of the distance toward the wine on the first loved and increments n', () => {
    const p = profile(axes(3, 3, 3, 3), axes(3, 3, 3, 3), 0);
    const updated = applyFeedback(p, { ...axes(5, 4, 1, 5), color: 'white' }, 'loved');
    expectAxesCloseTo(updated.white.axes, axes(3.9, 3.45, 2.1, 3.9));
    expect(updated.white.n).toBe(1);
  });

  it('moves axes away from the wine on not_for_me and increments n', () => {
    const p = profile(axes(3, 3, 3, 3), axes(3, 3, 3, 3), 0);
    const updated = applyFeedback(p, { ...axes(5, 4, 1, 5), color: 'white' }, 'not_for_me');
    expectAxesCloseTo(updated.white.axes, axes(2.1, 2.55, 3.9, 2.1));
    expect(updated.white.n).toBe(1);
  });

  it('moves profile 2/2/4/4 toward wine 4/1/2/2 on the first loved', () => {
    const p = profile(axes(2, 2, 4, 4));
    const updated = applyFeedback(p, { ...axes(4, 1, 2, 2), color: 'red' }, 'loved');
    expectAxesCloseTo(updated.red.axes, axes(2.9, 1.55, 3.1, 3.1));
    expect(updated.red.n).toBe(1);
  });

  it('moves profile 2.2/1.9/3.8/3.8 toward wine 4/1/2/2 on the first loved', () => {
    const p = profile(axes(2.2, 1.9, 3.8, 3.8));
    const updated = applyFeedback(p, { ...axes(4, 1, 2, 2), color: 'red' }, 'loved');
    expect(updated.red.axes.acidity).toBeCloseTo(3.0, 1);
    expect(updated.red.axes.sweetness).toBeCloseTo(1.5, 1);
    expect(updated.red.axes.tannin).toBeCloseTo(3.0, 1);
    expect(updated.red.axes.body).toBeCloseTo(3.0, 1);
    expect(updated.red.n).toBe(1);
  });

  it('clamps axes to 1-5', () => {
    const p = profile(axes(1, 1, 5, 5), axes(1, 1, 5, 5), 0);
    const updated = applyFeedback(p, { ...axes(5, 5, 1, 1), color: 'white' }, 'not_for_me');
    expect(updated.white.axes).toEqual(axes(1, 1, 5, 5));
    expect(updated.white.n).toBe(1);
  });
});
