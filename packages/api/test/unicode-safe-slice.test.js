import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sliceUnicodeSafe } from '../dist/utils/unicode-safe-slice.js';

test('safe slices preserve complete Unicode characters and existing UTF-16 budgets', () => {
  const cases = [
    ['a😼b', 0, 2, 'a'],
    ['a😼b', 0, 3, 'a😼'],
    ['a😼b', 2, undefined, 'b'],
    ['a😼b', -2, undefined, 'b'],
    ['a😼b', -3, undefined, '😼b'],
    ['a😼b', 1, 2, ''],
    ['a😼b', 2, 3, ''],
    ['a😼b', 2, 2, ''],
    ['a😼b', 0, -2, 'a'],
    ['a😼b', 4, 1, ''],
    ['中文abc', 1, 4, '文ab'],
    ['', 0, undefined, ''],
    ['a😼b', Number.NaN, Number.POSITIVE_INFINITY, 'a😼b'],
    ['a😼b', 1.9, 3.8, '😼'],
  ];
  for (const [value, start, end, expected] of cases) {
    const actual = sliceUnicodeSafe(value, start, end);
    assert.equal(actual, expected);
    assert.ok(actual.isWellFormed());
    assert.ok(actual.length <= value.slice(start, end).length);
  }
});

test('safe slicing leaves malformed source text visible to the existing transport validator', () => {
  assert.equal(sliceUnicodeSafe('\uDC00raw\uD800', 0), '\uDC00raw\uD800');
  assert.equal(sliceUnicodeSafe('a\uDC00raw\uD800z', 1, -1), '\uDC00raw\uD800');
});

test('all boundary positions of adjacent non-BMP characters produce valid substrings', () => {
  const value = '字😼🐾𠮷e\u0301尾';
  for (let start = -value.length - 1; start <= value.length + 1; start++) {
    for (let end = -value.length - 1; end <= value.length + 1; end++) {
      const actual = sliceUnicodeSafe(value, start, end);
      assert.ok(actual.isWellFormed(), `invalid slice ${start}:${end}`);
      assert.ok(actual.length <= value.slice(start, end).length);
      assert.ok(value.includes(actual), 'safe slicing must not substitute characters');
    }
  }
});
