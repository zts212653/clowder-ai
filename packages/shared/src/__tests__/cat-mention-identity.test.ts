import { describe, expect, it } from 'vitest';
import { buildCatMentionIdentities, buildUserMentionAliases, formatCatIdentityLabel } from '../cat-mention-identity.js';

const whale = { id: 'dsh', displayName: '小鲸鱼', nickname: '鲸鲸', mentionPatterns: ['@dsh'] };

describe('human mention identity', () => {
  it('combines trimmed identity fields and preserves variant disambiguation', () => {
    expect(formatCatIdentityLabel({ ...whale, displayName: ' 小鲸鱼 ', nickname: ' 鲸鲸 ' })).toBe('小鲸鱼 · 鲸鲸');
    expect(formatCatIdentityLabel({ ...whale, variantLabel: 'Sonnet' })).toBe('小鲸鱼（Sonnet） · 鲸鲸');
    expect(formatCatIdentityLabel({ ...whale, nickname: '小鲸鱼' })).toBe('小鲸鱼');
    expect(formatCatIdentityLabel({ ...whale, nickname: ' ' })).toBe('小鲸鱼');
  });

  it('derives user aliases without changing catalog handles or stable ids', () => {
    expect(buildUserMentionAliases([whale]).get('dsh')).toBe('@小鲸鱼 · 鲸鲸');
    expect(whale.mentionPatterns).toEqual(['@dsh']);
    expect(buildUserMentionAliases([{ ...whale, mentionPatterns: [] }]).size).toBe(0);
  });

  it('keeps group keywords and their label prefixes out of single-member aliases', () => {
    for (const displayName of ['all', 'thread', '全体猫猫', '本帖', 'co-creator', 'all-fixture']) {
      const cat = { ...whale, displayName, nickname: '鲸鲸', breedId: 'fixture' };
      expect(buildUserMentionAliases([cat]).size, displayName).toBe(0);
      expect(buildCatMentionIdentities([cat]).get('dsh')?.insert).toBe('@dsh ');
    }
  });

  it('fails closed for identical labels with no unique registered handle', () => {
    const cats = [whale, { ...whale, id: 'other' }];
    expect(buildUserMentionAliases(cats).size).toBe(0);
    expect(buildCatMentionIdentities(cats).get('dsh')?.insert).toBeNull();
    expect(buildCatMentionIdentities(cats).get('other')?.insert).toBeNull();
  });

  it('does not steal a boundary-valid registered prefix from another member', () => {
    const cats = [whale, { ...whale, id: 'other', displayName: '另一位', nickname: '', mentionPatterns: ['@小鲸鱼'] }];
    expect(buildUserMentionAliases(cats).has('dsh')).toBe(false);
    expect(buildCatMentionIdentities(cats).get('dsh')?.insert).toBe('@dsh ');
  });

  it('reserves configured human aliases and their valid prefixes', () => {
    const felix = { ...whale, displayName: 'Felix', nickname: '' };
    expect(buildUserMentionAliases([felix], ['@Felix']).size).toBe(0);
    expect(buildCatMentionIdentities([felix], ['@Felix']).get('dsh')?.insert).toBe('@dsh ');
    expect(buildUserMentionAliases([{ ...felix, nickname: '鲸鲸' }], ['@Felix']).size).toBe(0);
  });
});
