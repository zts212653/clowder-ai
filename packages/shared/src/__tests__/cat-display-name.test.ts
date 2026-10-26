import { describe, expect, it } from 'vitest';
import { collectRosterFamilyLabels, formatCatDisplayName, formatRosterLabel } from '../cat-display-name.js';

describe('formatRosterLabel', () => {
  it('keeps the nickname next to a variant label, so the roster answers "who is 烁烁"', () => {
    expect(formatRosterLabel({ displayName: '暹罗猫', variantLabel: 'Gemini 4 Argon', nickname: '烁烁' })).toBe(
      '暹罗猫 Gemini 4 Argon/烁烁',
    );
    expect(formatRosterLabel({ displayName: '梵花猫', variantLabel: 'Kimi K3.1 Pro', nickname: '墨墨' })).toBe(
      '梵花猫 Kimi K3.1 Pro/墨墨',
    );
  });

  it('keeps the existing label for cats without a variant label', () => {
    expect(formatRosterLabel({ displayName: '梵花猫', nickname: '墨墨' })).toBe('梵花猫/墨墨');
    expect(formatRosterLabel({ displayName: '缅因猫', variantLabel: 'GPT-5.4' })).toBe('缅因猫 GPT-5.4');
  });

  it('does not repeat a family name the family row already shows in the same roster', () => {
    const roster = [
      { displayName: '暹罗猫', nickname: '烁烁' },
      { displayName: '暹罗猫', variantLabel: 'Gemini 3.8 Flash', nickname: '烁烁' },
      { displayName: '狸花猫', variantLabel: 'GLM-5.2', nickname: '小狸花' },
    ];
    const familyLabels = collectRosterFamilyLabels(roster);
    expect(roster.map((cat) => formatRosterLabel(cat, familyLabels))).toEqual([
      '暹罗猫/烁烁',
      '暹罗猫 Gemini 3.8 Flash',
      '狸花猫 GLM-5.2/小狸花',
    ]);
    // Without a family row in the roster (You's runtime catalog), every variant keeps its name.
    expect(formatRosterLabel(roster[1], collectRosterFamilyLabels(roster.slice(1)))).toBe(
      '暹罗猫 Gemini 3.8 Flash/烁烁',
    );
  });

  it('does not repeat a nickname the label already carries', () => {
    expect(
      formatRosterLabel({ displayName: '俄罗斯蓝猫 鲸鲸', variantLabel: 'DeepSeek V4.1 Flash-1017', nickname: '鲸鲸' }),
    ).toBe('俄罗斯蓝猫 鲸鲸 DeepSeek V4.1 Flash-1017');
    expect(formatRosterLabel({ displayName: '砚砚 · dot', variantLabel: 'ChatGPT dot', nickname: '砚砚 dot' })).toBe(
      '砚砚 · dot ChatGPT dot',
    );
    expect(formatRosterLabel({ displayName: '缅因猫 Luna', variantLabel: 'GPT-6 Luna', nickname: 'GPT-6 Luna' })).toBe(
      '缅因猫 Luna GPT-6 Luna',
    );
  });
});

describe('formatCatDisplayName', () => {
  it('trims the configured identity and uses full-width punctuation', () => {
    expect(formatCatDisplayName({ displayName: ' 缅因猫 ', variantLabel: ' sol ' })).toBe('缅因猫（sol）');
  });

  it('does not repeat a variant already present in the display name', () => {
    expect(formatCatDisplayName({ displayName: '布偶猫 Fable', variantLabel: 'fable' })).toBe('布偶猫 Fable');
  });

  it('omits an empty variant label', () => {
    expect(formatCatDisplayName({ displayName: ' 布偶猫 ', variantLabel: ' ' })).toBe('布偶猫');
  });
});
