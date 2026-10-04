import { describe, expect, it } from 'vitest';
import { withDistinctCatNames } from '../modification-choices';

describe('withDistinctCatNames', () => {
  it('keeps same-breed cats distinguishable by folding in the variant label', () => {
    const choices = withDistinctCatNames({
      cats: [
        { catId: 'codex', name: '缅因猫', mcpSupport: true, restrictions: [] },
        { catId: 'gpt52', name: '缅因猫', variantLabel: 'GPT-5.4', mcpSupport: true, restrictions: [] },
        { catId: 'codex-sol', name: '缅因猫', variantLabel: 'GPT-5.6 Sol', mcpSupport: true, restrictions: [] },
      ],
      threads: [],
    });

    expect(choices.cats.map((cat) => cat.name)).toEqual(['缅因猫', '缅因猫（GPT-5.4）', '缅因猫（GPT-5.6 Sol）']);
  });
});
