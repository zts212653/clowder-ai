import { describe, expect, it } from 'vitest';
import {
  formatCatDisplayName,
  resolveCatDisplayName,
  resolveCatNameplateName,
  resolveCatTechnicalLabel,
} from '../cat-display-name';

describe('cat display-name projection', () => {
  it('uses the nickname as the chat name without replacing the full identity', () => {
    const member = { displayName: '小鲸鱼', nickname: ' 鲸鲸 ', variantLabel: 'flash' };
    expect(resolveCatNameplateName('dsh', () => member)).toBe('鲸鲸');
    expect(formatCatDisplayName(member)).toBe('小鲸鱼（flash）');
    expect(resolveCatNameplateName('dsh', () => ({ ...member, nickname: ' ' }))).toBe('小鲸鱼（flash）');
    expect(resolveCatNameplateName('retired', () => undefined)).toBe('retired');
  });
  it('uses displayName with the configured variant suffix', () => {
    expect(formatCatDisplayName({ displayName: '缅因猫', variantLabel: 'sol' })).toBe('缅因猫（sol）');
  });

  it('uses displayName without adding an empty suffix', () => {
    expect(formatCatDisplayName({ displayName: ' 缅因猫 ', variantLabel: ' ' })).toBe('缅因猫');
  });

  it('does not repeat a variant already present in displayName', () => {
    expect(formatCatDisplayName({ displayName: '布偶猫 Fable', variantLabel: 'fable' })).toBe('布偶猫 Fable');
  });

  it('falls back to the stable catId for unknown or unloaded members', () => {
    expect(resolveCatDisplayName('cat-retired', () => undefined)).toBe('cat-retired');
  });

  it('keeps catId as secondary provenance on technical surfaces', () => {
    expect(resolveCatTechnicalLabel('cat-sol', () => ({ displayName: '缅因猫', variantLabel: 'sol' }))).toBe(
      '缅因猫（sol） · cat-sol',
    );
    expect(resolveCatTechnicalLabel('cat-retired', () => undefined)).toBe('cat-retired');
  });
});
