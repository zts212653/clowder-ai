import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('a2a handoff labels', () => {
  it('disambiguates cats that share the same breed display name', async () => {
    const { formatA2AHandoffCatLabel } = await import(
      '../dist/domains/cats/services/agents/routing/a2a-handoff-label.js'
    );

    assert.equal(
      formatA2AHandoffCatLabel('opus-47', { displayName: '布偶猫', variantLabel: 'Opus 4.7' }),
      '布偶猫(Opus 4.7)',
    );
    assert.equal(formatA2AHandoffCatLabel('opus', { displayName: '布偶猫' }), '布偶猫(opus)');
    assert.equal(
      formatA2AHandoffCatLabel('gpt52', { displayName: '缅因猫', variantLabel: 'GPT-5.4' }),
      '缅因猫(GPT-5.4)',
    );
  });

  it('falls back to the stable cat id when config is unavailable', async () => {
    const { formatA2AHandoffCatLabel } = await import(
      '../dist/domains/cats/services/agents/routing/a2a-handoff-label.js'
    );

    assert.equal(formatA2AHandoffCatLabel('unknown-cat'), 'unknown-cat');
  });
});
