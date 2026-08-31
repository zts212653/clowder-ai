// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildVoidAckEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import {
  classifyDurableTriggerResult,
  classifyTerminalDispositionResult,
  evaluateAckLiveness,
} from '../dist/domains/cats/services/agents/routing/a2a-ack-liveness.js';

/**
 * LI-005 — A2A Ack Liveness Detection unit tests.
 *
 * Red-first TDD: each test targets a specific detection scenario from the
 * LI-005 candidate definition (live-candidates-2026-07-14.md).
 */

/** Helper: build default input with overrides. */
function input(overrides = {}) {
  return {
    isA2AInvocation: true,
    toolNames: [],
    lineStartMentions: [],
    structuredTargetCats: [],
    hasCoCreatorLineStartMention: false,
    ...overrides,
  };
}

describe('evaluateAckLiveness', () => {
  // ── Core detection: void ack ────────────────────────────────────────────

  it('fires when A2A invocation ends without routing exit or durable trigger', () => {
    const result = evaluateAckLiveness(input());
    assert.equal(result.shouldEmit, true, 'should fire on bare A2A ack');
    assert.equal(result.hasRoutingExit, false);
    assert.equal(result.hasDurableTrigger, false);
  });

  // ── Suppression: non-A2A ────────────────────────────────────────────────

  it('never fires for user-initiated invocations', () => {
    const result = evaluateAckLiveness(input({ isA2AInvocation: false }));
    assert.equal(result.shouldEmit, false, 'user-initiated should not fire');
  });

  // ── Suppression: routing exits ──────────────────────────────────────────

  it('suppressed by line-start @mention (ball passed forward)', () => {
    const result = evaluateAckLiveness(input({ lineStartMentions: ['codex'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasRoutingExit, true);
  });

  it('suppressed by structured targetCats (post_message routing)', () => {
    const result = evaluateAckLiveness(input({ structuredTargetCats: ['opus'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasRoutingExit, true);
  });

  it('suppressed by @co-creator line-start mention', () => {
    const result = evaluateAckLiveness(input({ hasCoCreatorLineStartMention: true }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasRoutingExit, true);
  });

  it('suppressed by a confirmed structured terminal disposition', () => {
    const result = evaluateAckLiveness(input({ hasTerminalDisposition: true }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasRoutingExit, true);
    assert.equal(result.hasDurableTrigger, false);
  });

  // ── Suppression: durable triggers ───────────────────────────────────────

  it('suppressed by hold_ball tool call', () => {
    const result = evaluateAckLiveness(input({ toolNames: ['mcp__cat-cafe-collab__cat_cafe_hold_ball'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasDurableTrigger, true);
  });

  it('create_task does NOT suppress (bookkeeping only, no wake mechanism)', () => {
    const result = evaluateAckLiveness(input({ toolNames: ['cat_cafe_create_task'] }));
    assert.equal(result.shouldEmit, true, 'create_task has no invokeTrigger');
    assert.equal(result.hasDurableTrigger, false);
  });

  it('suppressed by register_scheduled_task tool call', () => {
    const result = evaluateAckLiveness(
      input({ toolNames: ['mcp__cat-cafe-collab__cat_cafe_register_scheduled_task'] }),
    );
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasDurableTrigger, true);
  });

  it('suppressed by register_pr_tracking tool call', () => {
    const result = evaluateAckLiveness(input({ toolNames: ['cat_cafe_register_pr_tracking'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasDurableTrigger, true);
  });

  it('suppressed by register_issue_tracking tool call', () => {
    const result = evaluateAckLiveness(input({ toolNames: ['cat_cafe_register_issue_tracking'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasDurableTrigger, true);
  });

  it('suppressed by community_await_external tool call', () => {
    const result = evaluateAckLiveness(input({ toolNames: ['cat_cafe_community_await_external'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasDurableTrigger, true);
  });

  // ── Non-trigger tools do NOT suppress ───────────────────────────────────

  it('non-trigger tools (search_evidence, post_message, create_task) do not suppress', () => {
    const result = evaluateAckLiveness(
      input({
        toolNames: ['cat_cafe_search_evidence', 'cat_cafe_post_message', 'cat_cafe_create_task', 'Read', 'Bash'],
      }),
    );
    assert.equal(result.shouldEmit, true, 'informational/bookkeeping tools should not suppress');
    assert.equal(result.hasDurableTrigger, false);
  });

  // ── Combination: routing exit + no trigger still suppresses ─────────────

  it('routing exit alone suppresses even without durable trigger', () => {
    const result = evaluateAckLiveness(input({ lineStartMentions: ['sol'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasRoutingExit, true);
    assert.equal(result.hasDurableTrigger, false);
  });

  // ── Combination: trigger alone suppresses even without routing exit ─────

  it('durable trigger alone suppresses even without routing exit', () => {
    const result = evaluateAckLiveness(input({ toolNames: ['cat_cafe_hold_ball'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasRoutingExit, false);
    assert.equal(result.hasDurableTrigger, true);
  });
});

describe('classifyTerminalDispositionResult', () => {
  it('accepts successful dispatch completion across MCP transport names', () => {
    assert.equal(
      classifyTerminalDispositionResult('mcp:cat-cafe/complete_a2a_dispatch', '{"status":"ok"}', 'ok'),
      true,
    );
  });

  it('accepts successful managed-hold completion from its response body', () => {
    assert.equal(
      classifyTerminalDispositionResult(
        'mcp__cat-cafe-collab__cat_cafe_complete_managed_hold',
        '{"status":"ok"}',
        'unknown',
      ),
      true,
    );
  });

  it('fails closed for failed or unrelated tools', () => {
    assert.equal(
      classifyTerminalDispositionResult('cat_cafe_complete_a2a_dispatch', '{"status":"error"}', 'error'),
      false,
    );
    assert.equal(classifyTerminalDispositionResult('cat_cafe_create_task', '{"status":"ok"}', 'ok'), false);
  });
});

// ─── classifyDurableTriggerResult (Sol R3 P1 fix) ────────────────────────────

describe('classifyDurableTriggerResult', () => {
  // ── Level 1: structural toolResultStatus ─────────────────────────────────

  it('returns true when toolResultStatus is ok (Codex/Gemini)', () => {
    assert.equal(classifyDurableTriggerResult('cat_cafe_hold_ball', '{}', 'ok'), true);
  });

  it('returns false when toolResultStatus is error', () => {
    assert.equal(classifyDurableTriggerResult('cat_cafe_hold_ball', '{}', 'error'), false);
  });

  // ── Level 2: tool-specific body parsing ──────────────────────────────────

  it('hold_ball: {status: "ok"} → confirmed', () => {
    const body = JSON.stringify({ status: 'ok', held: true, taskId: 'hold-123' });
    assert.equal(classifyDurableTriggerResult('cat_cafe_hold_ball', body, undefined), true);
  });

  it('register_pr_tracking: {status: "ok"} → confirmed', () => {
    const body = JSON.stringify({ status: 'ok', threadId: 't-1', task: {} });
    assert.equal(classifyDurableTriggerResult('cat_cafe_register_pr_tracking', body, undefined), true);
  });

  it('register_issue_tracking: {status: "ok"} → confirmed', () => {
    const body = JSON.stringify({ status: 'ok', threadId: 't-1', task: {} });
    assert.equal(classifyDurableTriggerResult('cat_cafe_register_issue_tracking', body, undefined), true);
  });

  it('register_scheduled_task: {success: true} → confirmed (Sol R3 P1)', () => {
    const body = JSON.stringify({ success: true, task: { id: 'dyn-123', label: 'test' } });
    assert.equal(classifyDurableTriggerResult('cat_cafe_register_scheduled_task', body, undefined), true);
  });

  it('community_await_external: {state: "awaiting_external"} → confirmed (Sol R3 P1)', () => {
    const body = JSON.stringify({ subjectKey: 'sk-1', appended: true, state: 'awaiting_external' });
    assert.equal(classifyDurableTriggerResult('cat_cafe_community_await_external', body, undefined), true);
  });

  // ── MCP prefix variant ───────────────────────────────────────────────────

  it('handles mcp__cat-cafe-collab__ prefix (suffix matching)', () => {
    const body = JSON.stringify({ success: true, task: {} });
    assert.equal(
      classifyDurableTriggerResult('mcp__cat-cafe-collab__cat_cafe_register_scheduled_task', body, undefined),
      true,
    );
  });

  // ── Failure cases ────────────────────────────────────────────────────────

  it('returns false for explicit error body', () => {
    assert.equal(classifyDurableTriggerResult('cat_cafe_hold_ball', '{"isError":true}', undefined), false);
  });

  it('returns false for non-JSON content (fail-closed)', () => {
    assert.equal(classifyDurableTriggerResult('cat_cafe_hold_ball', 'Rate limit exceeded', undefined), false);
  });

  it('returns false for unknown body shape (fail-closed)', () => {
    assert.equal(classifyDurableTriggerResult('cat_cafe_hold_ball', '{"foo":"bar"}', undefined), false);
  });

  it('returns false for empty content', () => {
    assert.equal(classifyDurableTriggerResult('cat_cafe_hold_ball', undefined, undefined), false);
  });

  // ── Non-durable-trigger tools are always false ───────────────────────────

  it('returns false for non-durable-trigger tools even with ok status', () => {
    assert.equal(classifyDurableTriggerResult('cat_cafe_post_message', '{"status":"ok"}', 'ok'), false);
    assert.equal(classifyDurableTriggerResult('cat_cafe_create_task', '{"status":"ok"}', 'ok'), false);
  });
});

// ─── buildVoidAckEvent builder tests ──────────────────────────────────────

describe('buildVoidAckEvent', () => {
  it('builds well-formed ball.void_ack event without trigger ID', () => {
    const event = buildVoidAckEvent({ threadId: 't-1', messageId: 'm-42', at: 1700000000000 });
    assert.equal(event.kind, 'ball.void_ack');
    assert.equal(event.classification, 'state-changing');
    assert.equal(event.subjectKey, 'ball:thread:t-1');
    assert.equal(event.sourceEventId, 'route:m-42:void_ack');
    assert.equal(event.at, 1700000000000);
    assert.deepEqual(event.payload, {});
  });

  it('includes a2aTriggerMessageId in payload when provided (provenance)', () => {
    const event = buildVoidAckEvent({
      threadId: 't-1',
      messageId: 'm-42',
      a2aTriggerMessageId: 'trigger-msg-99',
      at: 1700000000000,
    });
    assert.equal(event.kind, 'ball.void_ack');
    assert.deepEqual(event.payload, { a2aTriggerMessageId: 'trigger-msg-99' });
  });

  it('sourceEventId differs from void_pass for same messageId', () => {
    const ack = buildVoidAckEvent({ threadId: 't-1', messageId: 'm-42', at: 1700000000000 });
    // void_pass uses `route:{messageId}:void`, ack uses `route:{messageId}:void_ack`
    assert.ok(ack.sourceEventId.endsWith(':void_ack'));
    assert.ok(!ack.sourceEventId.endsWith(':void_ack:void_ack'), 'no double suffix');
  });
});
