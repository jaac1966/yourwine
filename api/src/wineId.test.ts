import { describe, expect, it } from 'vitest';
import { canonicalName, slug, wineId } from './wineId';

describe('slug', () => {
  it('lowercases, strips accents, drops punctuation, spaces to dashes', () => {
    expect(slug('Viña del Mar')).toBe('vina-del-mar');
    expect(slug('Côtes du Rhône')).toBe('cotes-du-rhone');
  });

  it('handles dots and initials', () => {
    expect(slug('L.A. Cetto')).toBe('la-cetto');
  });
});

describe('wineId', () => {
  it('joins producer, name and vintage', () => {
    expect(wineId('L.A. Cetto', 'Cabernet Sauvignon', 2020)).toBe('la-cetto-cabernet-sauvignon-2020');
  });

  it('uses nv for null or missing vintage', () => {
    expect(wineId('Freixenet', 'Carta Nevada', null)).toBe('freixenet-carta-nevada-nv');
    expect(wineId('Freixenet', 'Carta Nevada')).toBe('freixenet-carta-nevada-nv');
  });

  it('strips a repeated producer prefix from the name', () => {
    expect(wineId('Bread & Butter', 'Bread & Butter Red Blend', 2022)).toBe('bread-butter-red-blend-2022');
  });
});

describe('canonicalName', () => {
  it('is producer plus distinctive name with the vintage year removed', () => {
    expect(canonicalName('Bread & Butter', 'Bread & Butter Red Blend', 2022)).toBe('Bread & Butter Red Blend');
    expect(canonicalName('Bread & Butter', 'Red Blend', 2022)).toBe('Bread & Butter Red Blend');
    expect(canonicalName('Georges Duboeuf', 'Georges Duboeuf Beaujolais-Villages 2021', 2021)).toBe('Georges Duboeuf Beaujolais-Villages');
  });

  it('collapses every leading repeat of the producer to one', () => {
    expect(canonicalName('Bread & Butter', 'Bread & Butter Bread & Butter Red Blend 2022', 2022)).toBe('Bread & Butter Red Blend');
  });

  it('strips a trailing vintage year when vintage is set', () => {
    expect(canonicalName('', 'Georges Duboeuf Beaujolais-Villages 2021', 2021)).toBe('Georges Duboeuf Beaujolais-Villages');
  });

  it('strips a plausible year when vintage is null, keeps other trailing numbers', () => {
    expect(canonicalName('', 'Some Wine 2019', null)).toBe('Some Wine');
    expect(canonicalName('', 'Some Wine 1899', null)).toBe('Some Wine 1899');
    expect(canonicalName('', 'Wine 2021', 2022)).toBe('Wine 2021');
  });

  it('leaves a name without producer or year unchanged', () => {
    expect(canonicalName('', 'Beaujolais-Villages', null)).toBe('Beaujolais-Villages');
  });
});

describe('canonical wine identity', () => {
  it('maps year and no-year reads of the same bottle to one id and name', () => {
    const withYear = canonicalName('Bread & Butter', 'Bread & Butter Red Blend 2022', 2022);
    const withoutYear = canonicalName('Bread & Butter', 'Red Blend', 2022);
    expect(withYear).toBe('Bread & Butter Red Blend');
    expect(withoutYear).toBe('Bread & Butter Red Blend');
    expect(wineId('Bread & Butter', withYear, 2022)).toBe('bread-butter-red-blend-2022');
    expect(wineId('Bread & Butter', withoutYear, 2022)).toBe('bread-butter-red-blend-2022');
  });

  it('builds the id from the canonical name', () => {
    const name = canonicalName('Georges Duboeuf', 'Beaujolais-Villages 2021', 2021);
    expect(name).toBe('Georges Duboeuf Beaujolais-Villages');
    // slug() strips hyphens (unchanged wineId behavior); the id is stable either way.
    expect(wineId('Georges Duboeuf', name, 2021)).toBe('georges-duboeuf-beaujolaisvillages-2021');
  });
});
