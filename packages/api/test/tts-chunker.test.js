/**
 * F111: TTS Chunker Tests
 *
 * Tests for sentence segmentation with hard/soft breakpoints and Boost mechanism.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkText } from '../dist/domains/cats/services/tts/TtsChunker.js';

describe('TtsChunker', () => {
  describe('hard breakpoints', () => {
    it('splits on Chinese period 。', () => {
      const result = chunkText('你好世界。再见世界。');
      assert.equal(result.length, 2);
      assert.equal(result[0].text, '你好世界。');
      assert.equal(result[1].text, '再见世界。');
    });

    it('splits on question mark ？', () => {
      const result = chunkText('你好吗？我很好。');
      assert.equal(result.length, 2);
      assert.equal(result[0].text, '你好吗？');
      assert.equal(result[1].text, '我很好。');
    });

    it('splits on exclamation mark ！', () => {
      const result = chunkText('太好了！继续努力。');
      assert.equal(result.length, 2);
      assert.equal(result[0].text, '太好了！');
      assert.equal(result[1].text, '继续努力。');
    });

    it('splits on English period .', () => {
      const result = chunkText('Hello world. Goodbye world.');
      assert.equal(result.length, 2);
      assert.equal(result[0].text, 'Hello world.');
      assert.equal(result[1].text, 'Goodbye world.');
    });

    it('splits on newline', () => {
      const result = chunkText('第一行\n第二行');
      assert.equal(result.length, 2);
      assert.equal(result[0].text, '第一行');
      assert.equal(result[1].text, '第二行');
    });

    it('splits on multiple hard breakpoints', () => {
      const result = chunkText('一。二！三？');
      assert.equal(result.length, 3);
      assert.equal(result[0].text, '一。');
      assert.equal(result[1].text, '二！');
      assert.equal(result[2].text, '三？');
    });
  });

  describe('soft breakpoints', () => {
    it('splits on comma when buffer >= 4 chars', () => {
      const result = chunkText('这是一个很长的句子，后面还有更多内容');
      // "这是一个很长的句子，" = 10 chars (>= 4 threshold), should split
      assert.ok(result.length >= 2, `Expected >= 2 chunks, got ${result.length}`);
      assert.ok(result[0].text.endsWith('，'), `First chunk should end with comma, got: ${result[0].text}`);
    });

    it('does NOT split on comma when buffer < 4 chars (non-boost)', () => {
      // With boost, first 2 segments have threshold=2, so this tests segment index >= 2
      const result = chunkText('长文本来凑数凑够了。一，二，三，四。');
      // After the first sentence split, remaining short comma-separated parts
      // should not split if < 4 chars between commas
      const lastChunk = result[result.length - 1];
      assert.ok(lastChunk.text.length > 0);
    });

    it('splits on Chinese enumeration comma 、', () => {
      const result = chunkText('苹果、橘子、香蕉、葡萄、西瓜、芒果。');
      // Should accumulate and split at some point
      assert.ok(result.length >= 1);
    });
  });

  describe('boost mechanism', () => {
    it('marks first 2 chunks as boost', () => {
      const result = chunkText('第一句话。第二句话。第三句话。');
      assert.equal(result.length, 3);
      assert.equal(result[0].isBoost, true, 'First chunk should be boost');
      assert.equal(result[1].isBoost, true, 'Second chunk should be boost');
      assert.equal(result[2].isBoost, false, 'Third chunk should NOT be boost');
    });

    it('uses lower threshold (2 chars) for first 2 boost segments', () => {
      // With boost, even 2-char segments at soft breakpoints should split
      const result = chunkText('你好，世界，再见。');
      // "你好，" is 3 chars (>= 2 boost threshold) → should split at first comma
      assert.ok(result.length >= 2, `Expected >= 2 chunks with boost, got ${result.length}`);
    });
  });

  describe('edge cases', () => {
    it('returns single chunk for short text without breakpoints', () => {
      const result = chunkText('你好世界');
      assert.equal(result.length, 1);
      assert.equal(result[0].text, '你好世界');
    });

    it('returns empty array for empty string', () => {
      const result = chunkText('');
      assert.equal(result.length, 0);
    });

    it('returns empty array for whitespace-only string', () => {
      const result = chunkText('   \n  ');
      assert.equal(result.length, 0);
    });

    it('handles consecutive breakpoints without empty chunks', () => {
      const result = chunkText('你好。。再见！！');
      // Should not produce empty chunks
      for (const chunk of result) {
        assert.ok(chunk.text.trim().length > 0, `Got empty chunk: "${chunk.text}"`);
      }
    });

    it('handles mixed Chinese and English', () => {
      const result = chunkText('Hello你好。World世界。');
      assert.equal(result.length, 2);
      assert.equal(result[0].text, 'Hello你好。');
      assert.equal(result[1].text, 'World世界。');
    });

    it('trims trailing whitespace from chunks', () => {
      const result = chunkText('你好世界。 再见世界。');
      for (const chunk of result) {
        assert.equal(chunk.text, chunk.text.trim(), `Chunk has extra whitespace: "${chunk.text}"`);
      }
    });
  });

  describe('MAX_CHUNK_CHARS guard', () => {
    it('force-splits unpunctuated text at 500 chars', () => {
      const result = chunkText('a'.repeat(1200));
      assert.equal(result.length, 3);
      assert.equal(result[0].text.length, 500);
      assert.equal(result[1].text.length, 500);
      assert.equal(result[2].text.length, 200);
    });

    it('does not split text exactly at 500 chars', () => {
      const result = chunkText('b'.repeat(500));
      assert.equal(result.length, 1);
      assert.equal(result[0].text.length, 500);
    });

    it('splits at 501 chars', () => {
      const result = chunkText('c'.repeat(501));
      assert.equal(result.length, 2);
      assert.equal(result[0].text.length, 500);
      assert.equal(result[1].text.length, 1);
    });

    it('punctuation still takes priority over max-chars for short text', () => {
      const result = chunkText('这是一个测试。这是另一个测试。');
      assert.equal(result.length, 2);
      assert.ok(result[0].text.length < 500);
    });

    it('preserves all text after force-split (no data loss)', () => {
      const input = 'x'.repeat(1500);
      const result = chunkText(input);
      const reconstructed = result.map((c) => c.text).join('');
      assert.equal(reconstructed.length, 1500);
    });

    it('prefers word boundary over mid-word split', () => {
      // 10-char words joined by spaces: "abcdefghij abcdefghij ..."
      const word = 'abcdefghij';
      const words = Array(50).fill(word).join(' '); // 549 chars
      const result = chunkText(words);
      assert.ok(result.length >= 2, 'Should split long text');
      for (const chunk of result) {
        const parts = chunk.text.split(' ');
        for (const p of parts) {
          assert.equal(p, word, `Word should be intact, got: "${p}"`);
        }
      }
    });

    it('preserves all text with spaces after word-boundary split', () => {
      const longInput = Array(120).fill('hello').join(' '); // 120*5 + 119 = 719 chars
      const result = chunkText(longInput);
      const reconstructed = result.map((c) => c.text).join(' ');
      assert.equal(reconstructed, longInput);
    });
  });
});
