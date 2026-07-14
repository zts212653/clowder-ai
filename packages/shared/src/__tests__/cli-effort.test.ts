import { describe, expect, it } from 'vitest';
import { getCliEffortOptionsForProvider } from '../cli-effort.js';

describe('CLI effort presets', () => {
  it('adds max and ultra to the maintained OpenAI presets only for GPT-5.6 models', () => {
    expect(getCliEffortOptionsForProvider('openai', 'gpt-5.6-terra')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(getCliEffortOptionsForProvider('openai', 'openai/gpt-5.6-sol')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(getCliEffortOptionsForProvider('openai', 'gpt-5.5')).toEqual(['low', 'medium', 'high', 'xhigh']);
  });
});
