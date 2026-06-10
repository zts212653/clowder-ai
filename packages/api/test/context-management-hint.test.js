/**
 * F225 软层: context-management-hint module — build + render + DELIVER the
 * cat-facing warn hint.
 *
 * Delivery is the crux (cloud review P1): a `system_info` output never reaches
 * the cat (routing only feeds `text` into previousResponses; ContextAssembler
 * excludes userId='system'). So the hint must ride the prompt-injection channel —
 * queued on the warn turn, taken back as a prompt prefix on the cat's next turn.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

async function loadModule() {
  return import('../dist/domains/cats/services/agents/invocation/context-management-hint.js');
}

describe('context-management-hint (F225 soft layer)', () => {
  test('buildContextManagementHint: exact → exact_token, warn severity', async () => {
    const { buildContextManagementHint } = await loadModule();
    const hint = buildContextManagementHint({ source: 'exact', compressionCount: 0 });
    assert.equal(hint.severity, 'warn');
    assert.equal(hint.fillConfidence, 'exact_token', 'exact CLI token usage → trust the %');
    assert.equal(hint.compressionCount, 0);
  });

  test('buildContextManagementHint: approx → approx_token, compressionCount passthrough', async () => {
    const { buildContextManagementHint } = await loadModule();
    const hint = buildContextManagementHint({ source: 'approx', compressionCount: 2 });
    assert.equal(hint.fillConfidence, 'approx_token', 'fallback window / aggregate → weak signal');
    assert.equal(hint.compressionCount, 2, 'compression count passes through as drift anchor');
  });

  test('formatContextManagementHint: renders L0 trigger phrase + fields + skill pointer', async () => {
    const { formatContextManagementHint } = await loadModule();
    const text = formatContextManagementHint({ severity: 'warn', fillConfidence: 'exact_token', compressionCount: 3 });
    assert.match(text, /context_management_hint/, 'must carry the L0 §8 reflex anchor verbatim');
    assert.match(text, /warn/);
    assert.match(text, /exact_token/);
    assert.match(text, /3/, 'compressionCount surfaced as drift anchor');
    assert.match(text, /context-self-management/, 'points the cat to the skill');
  });

  // The reviewer's P1: the hint must actually reach the cat. It rides the
  // prompt-injection channel (queue on warn turn → take as prompt prefix next turn).
  describe('pending delivery (queue → take = the prompt-injection channel)', () => {
    afterEach(async () => {
      const { __resetContextHints } = await loadModule();
      __resetContextHints();
    });

    test('queued hint is taken back as a prompt prefix containing the trigger', async () => {
      const { queueContextHint, takeContextHintPrefix } = await loadModule();
      queueContextHint('u:codex:t1', { severity: 'warn', fillConfidence: 'exact_token', compressionCount: 1 });
      const prefix = takeContextHintPrefix('u:codex:t1');
      assert.ok(prefix && prefix.includes('context_management_hint'), 'cat-facing prefix is delivered');
    });

    test('consumed once — second take returns null (no infinite re-injection)', async () => {
      const { queueContextHint, takeContextHintPrefix } = await loadModule();
      queueContextHint('u:codex:t1', { severity: 'warn', fillConfidence: 'approx_token', compressionCount: 0 });
      takeContextHintPrefix('u:codex:t1');
      assert.equal(takeContextHintPrefix('u:codex:t1'), null, 'cleared after delivery');
    });

    test('keyed per (user,cat,thread) — other key returns null', async () => {
      const { queueContextHint, takeContextHintPrefix } = await loadModule();
      queueContextHint('u:codex:t1', { severity: 'warn', fillConfidence: 'exact_token', compressionCount: 0 });
      assert.equal(takeContextHintPrefix('u:codex:t2'), null, 'no cross-thread leakage');
    });
  });
});
