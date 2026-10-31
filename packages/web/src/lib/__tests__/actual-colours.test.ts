import { describe, expect, it } from 'vitest';
import { actualColoursOf, CLASSIC_HUMAN, COCOA_HUMAN } from '../actual-colours';
import { hexToOklch } from '../color-utils';
import { readHueChroma, themeColourSources } from '../theme-colour-sources';

/**
 * F322 B follow-up (Opus 5.5 3619): the colours the name role, the plate and the lineage ring are checked against are the
 * ones that are painted — the same list CatHueInjector uses, the human colour the shell that is showing really paints.
 */
const cats = [
  { id: 'opus', color: { primary: '#9B7EBD' } },
  { id: 'codex', color: { primary: '#5B8C5A' } },
  { id: 'no color', color: { primary: '#ff0000' } }, // not CSS safe: the injector skips it, so does the list
  { id: 'plain' }, // no colour: neutral, but it still has tokens
];

describe('themeColourSources', () => {
  it('lists the catalogue the way CatHueInjector walks it: CSS-safe ids only, a colourless cat kept, connectors once each', () => {
    const sources = themeColourSources(cats);
    const ids = sources.map((source) => source.id);

    expect(ids.slice(0, 3)).toEqual(['opus', 'codex', 'plain']);
    expect(ids).not.toContain('no color');
    expect(new Set(ids).size).toBe(ids.length);
    expect(sources.length).toBeGreaterThan(3); // the connector sources follow the cats
    expect(sources.find((source) => source.id === 'plain')?.hex).toBeUndefined();
  });

  it('reads hue and chroma rounded to what the injector writes, and says null for a colour it cannot read', () => {
    const oklch = hexToOklch('#9B7EBD');

    expect(readHueChroma('#9B7EBD')).toEqual({ h: Number(oklch.h.toFixed(1)), c: Number(oklch.c.toFixed(3)) });
    expect(readHueChroma(undefined)).toBeNull();
    expect(readHueChroma('not a colour')).toBeNull();
  });
});

describe('actualColoursOf', () => {
  it('is undefined while no catalogue has arrived: nothing is known about the room yet', () => {
    expect(actualColoursOf({ cats: [], loaded: false, shell: 'v2', humanPrimary: '#6B5443' })).toBeUndefined();
    expect(actualColoursOf({ cats, loaded: false, shell: 'v2', humanPrimary: '#6B5443' })).toBeUndefined();
  });

  it('knows the room once the catalogue has loaded, even when it is empty (first run): connectors and the human still paint (cloud #5086 round 3)', () => {
    const actual = actualColoursOf({ cats: [], loaded: true, shell: 'v2', humanPrimary: '#00ff00' });

    expect(actual).toBeDefined();
    // The connector sources the injector paints with no cat at all, and the configured human colour.
    expect(actual?.cats.length).toBe(themeColourSources([]).length);
    expect(actual?.cats.length).toBeGreaterThan(0);
    expect(actual?.human).toEqual(readHueChroma('#00ff00'));
  });

  it('gives every source its own hue and chroma, and a neutral one to a cat without a readable colour', () => {
    const actual = actualColoursOf({ cats, loaded: true, shell: 'v2', humanPrimary: undefined });

    expect(actual?.cats[0]).toEqual(readHueChroma('#9B7EBD'));
    expect(actual?.cats[2]).toEqual({ h: 0, c: 0 }); // 'plain'
  });

  it('paints the human the way the shell on screen does', () => {
    const configured = actualColoursOf({ cats, loaded: true, shell: 'v2', humanPrimary: '#00ff00' });
    const unconfigured = actualColoursOf({ cats, loaded: true, shell: 'v2', humanPrimary: null });
    const unreadable = actualColoursOf({ cats, loaded: true, shell: 'v2', humanPrimary: 'zzz' });
    const classic = actualColoursOf({ cats, loaded: true, shell: 'classic', humanPrimary: '#00ff00' });

    expect(configured?.human).toEqual(readHueChroma('#00ff00'));
    expect(unconfigured?.human).toEqual(COCOA_HUMAN);
    expect(unreadable?.human).toEqual(COCOA_HUMAN);
    expect(classic?.human).toEqual(CLASSIC_HUMAN); // the classic shell never reads the config
  });
});
