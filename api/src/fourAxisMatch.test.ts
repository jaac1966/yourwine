import { describe, expect, it } from 'vitest';
import { applyFeedback, fourAxisMatch, type Axes, type Profile } from './fourAxisMatch';

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

  it('uses base when the user has 0 white tastings', () => {
    const p = profile(axes(3, 3, 3, 3), axes(1, 1, 1, 1), 0);
    expect(fourAxisMatch(p, { ...axes(3, 3, 3, 3), color: 'white' })).toBe(100);
  });

  it('lets the white overlay dominate after 5 white tastings', () => {
    const p = profile(axes(1, 1, 1, 1), axes(5, 5, 5, 5), 5);
    expect(fourAxisMatch(p, { ...axes(5, 5, 5, 5), color: 'white' })).toBe(100);
    const capped = profile(axes(1, 1, 1, 1), axes(5, 5, 5, 5), 10);
    expect(fourAxisMatch(capped, { ...axes(5, 5, 5, 5), color: 'white' })).toBe(100);
  });
});

describe('applyFeedback', () => {
  it('moves axes toward the wine on loved and increments n', () => {
    const p = profile(axes(3, 3, 3, 3), axes(3, 3, 3, 3), 0);
    const updated = applyFeedback(p, { ...axes(5, 4, 1, 5), color: 'white' }, 'loved');
    expect(updated.white.axes).toEqual(axes(3.5, 3.5, 2.5, 3.5));
    expect(updated.white.n).toBe(1);
  });

  it('moves axes away from the wine on not_for_me and increments n', () => {
    const p = profile(axes(3, 3, 3, 3), axes(3, 3, 3, 3), 0);
    const updated = applyFeedback(p, { ...axes(5, 4, 1, 5), color: 'white' }, 'not_for_me');
    expect(updated.white.axes).toEqual(axes(2.5, 2.5, 3.5, 2.5));
    expect(updated.white.n).toBe(1);
  });

  it('clamps axes to 1-5', () => {
    const p = profile(axes(1, 1, 5, 5), axes(1, 1, 5, 5), 0);
    const updated = applyFeedback(p, { ...axes(5, 5, 1, 1), color: 'white' }, 'not_for_me');
    expect(updated.white.axes).toEqual(axes(1, 1, 5, 5));
    expect(updated.white.n).toBe(1);
  });
});
