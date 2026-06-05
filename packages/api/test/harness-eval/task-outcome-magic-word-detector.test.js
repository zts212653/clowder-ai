import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectMagicWords,
  MAGIC_WORD_PATTERNS,
} from '../../dist/infrastructure/harness-eval/task-outcome/magic-word-detector.js';

describe('Magic Word Runtime Detector (F192 Phase G AC-G12)', () => {
  it('detects 脚手架 in user message', () => {
    const hits = detectMagicWords('这个方案是脚手架，不是终态');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].word, '脚手架');
  });

  it('detects 绕路了 in user message', () => {
    const hits = detectMagicWords('你绕路了，回到直线路径');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].word, '绕路了');
  });

  it('detects 喵约 in user message', () => {
    const hits = detectMagicWords('喵约！你忘了我们的约定');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].word, '喵约');
  });

  it('detects 星星罐子 (P0 emergency brake)', () => {
    const hits = detectMagicWords('星星罐子！立刻停止');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].word, '星星罐子');
  });

  it('detects 第一性原理 in user message', () => {
    const hits = detectMagicWords('第一性原理，你在堆复杂度');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].word, '第一性原理');
  });

  it('detects 数学之美 in user message', () => {
    const hits = detectMagicWords('数学之美，方案太复杂了');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].word, '数学之美');
  });

  it('detects 下次一定 in user message', () => {
    const hits = detectMagicWords('又下次一定？能做的现在做');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].word, '下次一定');
  });

  it('detects 我能猜出来 in user message', () => {
    const hits = detectMagicWords('我能猜出来！你在推理跳过查询');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].word, '我能猜出来');
  });

  it('detects 碎片够了 in user message', () => {
    const hits = detectMagicWords('碎片够了，再搜一轮不同角度');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].word, '碎片够了');
  });

  it('detects 补锅匠 in user message', () => {
    const hits = detectMagicWords('你是补锅匠，逐点修补不审视同类');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].word, '补锅匠');
  });

  it('detects multiple magic words in one message', () => {
    const hits = detectMagicWords('脚手架！绕路了！回来');
    assert.equal(hits.length, 2);
    const words = hits.map((h) => h.word);
    assert.ok(words.includes('脚手架'));
    assert.ok(words.includes('绕路了'));
  });

  it('returns empty for normal message', () => {
    const hits = detectMagicWords('请帮我看看这个 PR');
    assert.equal(hits.length, 0);
  });

  it('returns empty for empty message', () => {
    assert.equal(detectMagicWords('').length, 0);
  });

  it('MAGIC_WORD_PATTERNS has at least 9 entries', () => {
    assert.ok(MAGIC_WORD_PATTERNS.length >= 9, `Expected ≥9 patterns, got ${MAGIC_WORD_PATTERNS.length}`);
  });
});
