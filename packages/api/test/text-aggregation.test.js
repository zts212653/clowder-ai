import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  accumulateTextAggregate,
  accumulateTextParts,
  flattenTurnTextParts,
} from '../dist/domains/cats/services/agents/text-aggregation.js';

describe('text aggregation helper', () => {
  test('append mode concatenates text', () => {
    assert.equal(accumulateTextAggregate('hello', ' world', 'append'), 'hello world');
    const parts = ['hello'];
    const result = accumulateTextParts(parts, ' world', 'append');
    assert.strictEqual(result, parts, 'append mode should mutate in place');
    assert.deepEqual(parts, ['hello', ' world']);
  });

  test('replace mode overwrites accumulated text', () => {
    assert.equal(
      accumulateTextAggregate('第一段。第二段。', '第一段。插入一句。第二段。', 'replace'),
      '第一段。插入一句。第二段。',
    );
    const parts = ['第一段。第二段。'];
    const result = accumulateTextParts(parts, '第一段。插入一句。第二段。', 'replace');
    assert.strictEqual(result, parts, 'replace mode should also reuse the same array shell');
    assert.deepEqual(parts, ['第一段。插入一句。第二段。']);
  });

  test('flattenTurnTextParts preserves other turns when one turn was replaced', () => {
    assert.equal(
      flattenTurnTextParts([{ textParts: ['布偶猫前文。'] }, { textParts: ['孟加拉猫改写后的全文。'] }]),
      '布偶猫前文。孟加拉猫改写后的全文。',
    );
  });
});
