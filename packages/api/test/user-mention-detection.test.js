import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectUserMention } from '../dist/routes/user-mention.js';

describe('detectUserMention', () => {
  it('detects @铲屎官 at line start', () => {
    assert.equal(detectUserMention('请看这个\n@铲屎官\n帮忙确认'), true);
  });

  it('detects @co-creator at line start', () => {
    assert.equal(detectUserMention('@co-creator 请帮忙看看'), true);
  });

  it('ignores @铲屎官 in middle of line', () => {
    assert.equal(detectUserMention('告诉@铲屎官这件事'), false);
  });

  it('ignores @co-creator inside code block', () => {
    assert.equal(detectUserMention('```\n@co-creator\n```'), false);
  });

  it('returns false for no mention', () => {
    assert.equal(detectUserMention('普通消息没有 mention'), false);
  });

  it('handles leading whitespace before @co-creator', () => {
    assert.equal(detectUserMention('  @铲屎官 看看'), true);
  });

  it('returns false for empty string', () => {
    assert.equal(detectUserMention(''), false);
  });

  it('detects @co-creator case-insensitively', () => {
    assert.equal(detectUserMention('@Co-Creator 请看'), true);
    assert.equal(detectUserMention('@CO-CREATOR 请看'), true);
  });

  it('handles multiple code blocks correctly', () => {
    assert.equal(detectUserMention('```js\n@co-creator\n```\n普通文本\n```\n@铲屎官\n```'), false);
  });

  it('detects @铲屎官 after code block', () => {
    assert.equal(detectUserMention('```\ncode\n```\n@铲屎官 看看'), true);
  });

  it('OQ-1: rejects @co-creator123 (token boundary)', () => {
    assert.equal(detectUserMention('@co-creator123 not a real mention'), false);
  });

  it('OQ-1: accepts @co-creator followed by CJK punctuation', () => {
    assert.equal(detectUserMention('@co-creator，请看'), true);
  });

  it('OQ-1: accepts @co-creator at end of line', () => {
    assert.equal(detectUserMention('@co-creator'), true);
  });

  it('OQ-1: accepts @铲屎官 followed by space', () => {
    assert.equal(detectUserMention('@铲屎官 检查一下'), true);
  });

  it('R2-P2: accepts @co-creator followed by CJK text (no space)', () => {
    assert.equal(detectUserMention('@co-creator请看'), true);
  });

  it('R2-P2: accepts @铲屎官 followed by CJK text (no space)', () => {
    assert.equal(detectUserMention('@铲屎官请看'), true);
  });

  it('R2-P2: still rejects @co-creatorfoo (ASCII continuation)', () => {
    assert.equal(detectUserMention('@co-creatorfoo'), false);
  });

  // F067 co-creator config: default mention patterns from cat-template.json
  // The template provides @co-creator; @铲屎官 is always added as fallback.
  // Deployment-specific patterns (e.g. @co-creator) come from cat-catalog.json overlay.
  it('detects @铲屎官 at line start (always-present fallback)', () => {
    assert.equal(detectUserMention('@铲屎官 请看'), true);
    assert.equal(detectUserMention('@铲屎官请看'), true);
  });

  it('rejects @co-creator continuation (e.g. @co-creatorfoo)', () => {
    assert.equal(detectUserMention('@co-creatorfoo not a mention'), false);
  });

  it('accepts @co-creator followed by CJK text', () => {
    assert.equal(detectUserMention('@co-creator请看'), true);
  });
});
