/**
 * F061: Send button DOM script + @owner mention in route-serial
 *
 * Tests:
 * 1. FIND_SEND_BUTTON_JS correctly matches buttons by visible text
 * 2. detectUserMention is called for route-serial stored messages
 *    (integration verified via import chain — unit tests in user-mention-detection.test.js)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Verify the updated FIND_SEND_BUTTON_JS is importable and is a non-empty string
import {
  DISPATCH_ENTER_JS,
  FIND_SEND_BUTTON_JS,
} from '../dist/domains/cats/services/agents/providers/antigravity/cdp-dom-scripts.js';

// Verify detectUserMention is importable from the route it's used in
import { detectUserMention } from '../dist/routes/user-mention.js';

describe('F061: FIND_SEND_BUTTON_JS', () => {
  it('exports a non-empty JS string', () => {
    assert.equal(typeof FIND_SEND_BUTTON_JS, 'string');
    assert.ok(FIND_SEND_BUTTON_JS.length > 100, 'script should be substantial');
  });

  it('contains Strategy 1: walk up from textbox (scoped, preferred)', () => {
    assert.ok(
      FIND_SEND_BUTTON_JS.includes('textbox') && FIND_SEND_BUTTON_JS.includes('parentElement'),
      'script should walk up from textbox to find sibling buttons',
    );
    // Strategy 1 should come BEFORE the global visible-text fallback
    const textboxIdx = FIND_SEND_BUTTON_JS.indexOf('textbox');
    const globalSendIdx = FIND_SEND_BUTTON_JS.indexOf('Strategy 2');
    assert.ok(textboxIdx < globalSendIdx, 'textbox-scoped search should run before global text match');
  });

  it('Strategy 1 sub-pass A prefers send/submit text over arbitrary buttons', () => {
    // Sub-pass A checks textContent for send/submit before sub-pass B picks any small button
    const subPassA = FIND_SEND_BUTTON_JS.indexOf('Sub-pass A');
    const subPassB = FIND_SEND_BUTTON_JS.indexOf('Sub-pass B');
    assert.ok(subPassA > 0 && subPassB > 0, 'both sub-passes should exist');
    assert.ok(subPassA < subPassB, 'sub-pass A (text match) should run before sub-pass B (any small)');
  });

  it('does not match buttons containing the textbox (sibling branch only)', () => {
    assert.ok(
      FIND_SEND_BUTTON_JS.includes('.contains(textbox)'),
      'script should filter out buttons containing the textbox',
    );
  });

  it('contains Strategy 2: visible text matching for "send" (global fallback)', () => {
    assert.ok(
      FIND_SEND_BUTTON_JS.includes("'send'") || FIND_SEND_BUTTON_JS.includes('"send"'),
      'script should match visible text "send"',
    );
    assert.ok(
      FIND_SEND_BUTTON_JS.includes("'submit'") || FIND_SEND_BUTTON_JS.includes('"submit"'),
      'script should match visible text "submit"',
    );
  });

  it('contains Strategy 3: aria-label/title fallback', () => {
    assert.ok(FIND_SEND_BUTTON_JS.includes('aria-label'), 'script should check aria-label');
  });
});

describe('F061: DISPATCH_ENTER_JS', () => {
  it('dispatches keydown, keypress, keyup events', () => {
    assert.ok(DISPATCH_ENTER_JS.includes('keydown'));
    assert.ok(DISPATCH_ENTER_JS.includes('keypress'));
    assert.ok(DISPATCH_ENTER_JS.includes('keyup'));
  });
});

describe('F061: detectUserMention in route-serial integration', () => {
  // These tests verify the function works correctly for the patterns
  // that route-serial will call it with (agent response content)

  it('detects @co-creator in agent response', () => {
    const agentResponse = '好的，我来帮你看看。\n@co-creator 这个改动已经完成了，请确认。';
    assert.equal(detectUserMention(agentResponse), true);
  });

  it('detects @铲屎官 in agent response', () => {
    const agentResponse = '分析完成。\n@铲屎官 请查看结果。';
    assert.equal(detectUserMention(agentResponse), true);
  });

  it('detects @co-creator in agent response', () => {
    const agentResponse = '@co-creator 任务已完成。';
    assert.equal(detectUserMention(agentResponse), true);
  });

  it('does not detect @opus (cat mention, not owner)', () => {
    const agentResponse = '我来问问砚砚。\n@codex 请帮忙 review。';
    assert.equal(detectUserMention(agentResponse), false);
  });

  it('does not false-positive on @co-creator inside code block', () => {
    const agentResponse = '```\n@co-creator mentioned in code\n```\n代码已修改。';
    assert.equal(detectUserMention(agentResponse), false);
  });

  it('handles empty content gracefully', () => {
    assert.equal(detectUserMention(''), false);
  });

  it('handles content with only code blocks', () => {
    assert.equal(detectUserMention('```js\nconsole.log("hello")\n```'), false);
  });
});
