import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { chunkText } from '../dist/domains/cats/services/tts/TtsChunker.js';

describe('TtsChunker (compiled)', () => {
  it('splits Chinese sentences on hard breakpoints', () => {
    const result = chunkText('你好世界。再见世界。第三句话。');
    assert.equal(result.length, 3);
    assert.equal(result[0].isBoost, true);
    assert.equal(result[1].isBoost, true);
    assert.equal(result[2].isBoost, false);
  });

  it('handles empty input', () => {
    assert.equal(chunkText('').length, 0);
    assert.equal(chunkText('  ').length, 0);
  });
});
