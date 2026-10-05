import { describe, expect, it } from 'vitest';
import { humanColorState, isReadableHex } from '../human-color';

/**
 * F322 B segment 1 (human message). The colour state is a fact about the config, never a default:
 * no colour, or a colour that cannot be read, is `unconfigured`, and nothing is invented for it.
 */
describe('humanColorState', () => {
  it('is configured with the colour the config carries', () => {
    const color = { primary: '#815b5b', secondary: '#FFDDD2' };
    expect(humanColorState({ color })).toEqual({ status: 'configured', color });
  });

  it('is unconfigured when there is no config, no colour, or a colour that cannot be read', () => {
    expect(humanColorState(undefined)).toEqual({ status: 'unconfigured' });
    expect(humanColorState({})).toEqual({ status: 'unconfigured' });
    expect(humanColorState({ color: { primary: 'not-a-colour', secondary: '#FFDDD2' } })).toEqual({
      status: 'unconfigured',
    });
    expect(humanColorState({ color: { primary: '', secondary: '#FFDDD2' } })).toEqual({ status: 'unconfigured' });
  });

  it('reads the hex forms the colour utilities read', () => {
    for (const ok of ['#fff', 'fff', '#6B5443', '6b5443', '#6B5443FF']) expect(isReadableHex(ok), ok).toBe(true);
    for (const bad of ['#12', '#12345', '#gggggg', '', undefined, 12, null])
      expect(isReadableHex(bad), String(bad)).toBe(false);
  });
});
