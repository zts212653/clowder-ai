import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// Will be exported from antigravity-trace.ts
import { summarizeStepShape } from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-trace.js';

describe('summarizeStepShape', () => {
  test('passes through short strings unchanged', () => {
    const input = { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE' };
    const result = summarizeStepShape(input);
    assert.deepStrictEqual(result, input);
  });

  test('replaces long strings with length marker', () => {
    const longText = 'x'.repeat(200);
    const input = { plannerResponse: { response: longText, thinking: 'short' } };
    const result = summarizeStepShape(input);
    assert.equal(result.plannerResponse.response, '[string:200]');
    assert.equal(result.plannerResponse.thinking, 'short');
  });

  test('handles arrays of steps', () => {
    const input = [
      { type: 'A', status: 'DONE' },
      { type: 'B', data: 'y'.repeat(150) },
    ];
    const result = summarizeStepShape(input);
    assert.equal(result[0].type, 'A');
    assert.equal(result[1].data, '[string:150]');
  });

  test('preserves null, undefined, numbers, booleans', () => {
    const input = { a: null, b: undefined, c: 42, d: true, e: 'short' };
    const result = summarizeStepShape(input);
    assert.equal(result.a, null);
    assert.equal(result.b, undefined);
    assert.equal(result.c, 42);
    assert.equal(result.d, true);
    assert.equal(result.e, 'short');
  });

  test('respects custom maxStringLen threshold', () => {
    const input = { text: 'hello world' };
    const short = summarizeStepShape(input, 5);
    assert.equal(short.text, '[string:11]');
    const long = summarizeStepShape(input, 50);
    assert.equal(long.text, 'hello world');
  });

  test('reveals unknown fields not in TrajectoryStep interface', () => {
    // This is the key use case: upstream may send fields we don't know about
    const rawStep = {
      type: 'CORTEX_STEP_TYPE_SOMETHING_NEW',
      status: 'CORTEX_STEP_STATUS_DONE',
      unknownField: { nested: 'value', deep: { data: 'z'.repeat(200) } },
      anotherMystery: [1, 2, 3],
    };
    const result = summarizeStepShape(rawStep);
    // All keys preserved, including unknown ones
    assert.equal(result.unknownField.nested, 'value');
    assert.equal(result.unknownField.deep.data, '[string:200]');
    assert.deepStrictEqual(result.anotherMystery, [1, 2, 3]);
  });
});
