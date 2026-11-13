import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../sha256-hex';

const reference = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('matches the standard digest at every padding boundary and for multi-byte text', () => {
    const samples = ['', 'abc', '真正回答。', '🐾 emoji and 中文 mixed', 'x'.repeat(10_000)];
    // 55/56/63/64/119/120 bytes straddle the one- and two-block padding boundaries.
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) samples.push('a'.repeat(length));
    for (const text of samples) expect(sha256Hex(text), JSON.stringify(text.slice(0, 20))).toBe(reference(text));
  });

  it('matches the standard digest for random strings across the Unicode range', () => {
    let seed = 0x5eed;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed;
    };
    for (let round = 0; round < 300; round++) {
      const codePoints = Array.from({ length: next() % 400 }, () => {
        const point = next() % 0x110000;
        return point >= 0xd800 && point <= 0xdfff ? 0x20 : point;
      });
      const text = String.fromCodePoint(...codePoints);
      expect(sha256Hex(text)).toBe(reference(text));
    }
  });
});
