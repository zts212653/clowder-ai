/**
 * DegradationPolicy tests
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkContextBudget,
  checkExtractionBudget,
  formatDegradationMessage,
  isAtBoundary,
} from '../dist/domains/cats/services/orchestration/DegradationPolicy.js';

const mockBudget = {
  maxPromptTokens: 100000,
  maxContextTokens: 30000,
  maxMessages: 40,
  maxContentLengthPerMsg: 2000,
};

describe('checkContextBudget', () => {
  it('returns full strategy when within budget', () => {
    const result = checkContextBudget(20, mockBudget);
    assert.equal(result.degraded, false);
    assert.equal(result.strategy, 'full');
  });

  it('returns truncated when over budget', () => {
    const result = checkContextBudget(60, mockBudget);
    assert.equal(result.degraded, true);
    assert.equal(result.strategy, 'truncated');
    assert.ok(result.reason?.includes('截断'));
  });

  it('returns truncated with adjusted maxMessages', () => {
    const result = checkContextBudget(80, mockBudget);
    assert.equal(result.adjustedMaxMessages, 40);
  });

  it('handles exact boundary', () => {
    const result = checkContextBudget(40, mockBudget);
    assert.equal(result.degraded, false);
    assert.equal(result.strategy, 'full');
  });
});

describe('checkExtractionBudget', () => {
  it('returns full strategy when within budget', () => {
    const result = checkExtractionBudget(50000, mockBudget);
    assert.equal(result.degraded, false);
    assert.equal(result.strategy, 'full');
  });

  it('returns pattern_only when over 80% of budget', () => {
    const result = checkExtractionBudget(90000, mockBudget);
    assert.equal(result.degraded, true);
    assert.equal(result.strategy, 'pattern_only');
    assert.ok(result.reason?.includes('模式匹配'));
  });

  it('returns abort when way over budget', () => {
    const result = checkExtractionBudget(250000, mockBudget);
    assert.equal(result.degraded, true);
    assert.equal(result.strategy, 'abort');
    assert.ok(result.reason?.includes('无法处理'));
  });
});

describe('formatDegradationMessage', () => {
  it('returns empty for non-degraded', () => {
    const result = formatDegradationMessage({
      degraded: false,
      strategy: 'full',
    });
    assert.equal(result, '');
  });

  it('formats truncated with reason', () => {
    const result = formatDegradationMessage({
      degraded: true,
      strategy: 'truncated',
      reason: '消息数超出预算',
    });
    assert.ok(result.startsWith('[警告]'));
    assert.ok(result.includes('上下文已截断'));
    assert.ok(result.includes('消息数超出预算'));
  });

  it('formats pattern_only with reason', () => {
    const result = formatDegradationMessage({
      degraded: true,
      strategy: 'pattern_only',
      reason: '历史过长',
    });
    assert.ok(result.startsWith('[警告]'));
    assert.ok(result.includes('简化模式'));
    assert.ok(result.includes('历史过长'));
  });

  it('formats abort with reason', () => {
    const result = formatDegradationMessage({
      degraded: true,
      strategy: 'abort',
      reason: '无法处理',
    });
    assert.ok(result.startsWith('[错误]'));
    assert.ok(result.includes('无法处理'));
  });
});

describe('F8: token-based labels', () => {
  it('checkExtractionBudget reason mentions tokens not chars', () => {
    const result = checkExtractionBudget(90000, mockBudget);
    assert.ok(result.reason?.includes('tokens'), `expected "tokens" in reason: ${result.reason}`);
    assert.ok(!result.reason?.includes('chars'), `should not mention "chars": ${result.reason}`);
  });
});

describe('isAtBoundary', () => {
  it('returns true when exactly at boundary', () => {
    assert.equal(isAtBoundary(40, 40), true);
  });

  it('returns false when not at boundary', () => {
    assert.equal(isAtBoundary(39, 40), false);
    assert.equal(isAtBoundary(41, 40), false);
  });
});
