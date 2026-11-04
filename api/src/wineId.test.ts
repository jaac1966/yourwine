import { describe, expect, it } from 'vitest';
import { displayName, slug, wineId } from './wineId';

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

describe('displayName', () => {
  it('strips one repeated producer prefix and the trailing vintage year', () => {
    expect(displayName('Bread & Butter', 'Bread & Butter Bread & Butter Red Blend 2022', 2022)).toBe('Bread & Butter Red Blend');
  });

  it('strips a trailing vintage year when vintage is set', () => {
    expect(displayName('', 'Georges Duboeuf Beaujolais-Villages 2021', 2021)).toBe('Georges Duboeuf Beaujolais-Villages');
  });

  it('leaves a name without year or repeated producer unchanged', () => {
    expect(displayName('', 'Beaujolais-Villages', null)).toBe('Beaujolais-Villages');
    expect(displayName('Other Producer', 'Beaujolais-Villages', null)).toBe('Beaujolais-Villages');
  });
});
