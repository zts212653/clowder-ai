/**
 * Multi-Mention Timeout + Partial Failure Integration Tests (F086 M1)
 *
 * Tests timeout handling at the route/orchestrator integration level.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import './helpers/setup-cat-registry.js';

const { MultiMentionOrchestrator } = await import(
  '../dist/domains/cats/services/agents/routing/MultiMentionOrchestrator.js'
);

describe('Multi-Mention Timeout Integration', () => {
  const opus = createCatId('opus');
  const codex = createCatId('codex');
  const gemini = createCatId('gemini');

  /** @type {InstanceType<typeof MultiMentionOrchestrator>} */
  let orch;

  beforeEach(() => {
    orch = new MultiMentionOrchestrator();
  });

  test('timeout after partial: preserves received, marks missing as timeout', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator: opus,
      callbackTo: opus,
      targets: [codex, gemini],
      question: 'Design review',
      timeoutMinutes: 8,
    });
    orch.start(req.id);

    // codex responds, gemini does not
    orch.recordResponse(req.id, codex, 'Looks good!');
    assert.equal(orch.getStatus(req.id), 'partial');

    // Timeout fires
    orch.handleTimeout(req.id);
    assert.equal(orch.getStatus(req.id), 'timeout');

    // Result preserves codex response, marks gemini as timeout
    const result = orch.getResult(req.id);
    assert.equal(result.responses.length, 2);

    const codexResp = result.responses.find((r) => r.catId === codex);
    const geminiResp = result.responses.find((r) => r.catId === gemini);
    assert.equal(codexResp?.status, 'received');
    assert.equal(codexResp?.content, 'Looks good!');
    assert.equal(geminiResp?.status, 'timeout');
    assert.equal(geminiResp?.content, '');
  });

  test('timeout with no responses: all targets marked as timeout', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator: opus,
      callbackTo: opus,
      targets: [codex, gemini],
      question: 'Review',
      timeoutMinutes: 8,
    });
    orch.start(req.id);
    orch.handleTimeout(req.id);

    const result = orch.getResult(req.id);
    assert.equal(result.request.status, 'timeout');
    for (const resp of result.responses) {
      assert.equal(resp.status, 'timeout');
    }
  });

  test('late response after timeout does not change status', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator: opus,
      callbackTo: opus,
      targets: [codex],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);
    orch.handleTimeout(req.id);

    const status = orch.recordResponse(req.id, codex, 'late response');
    assert.equal(status, 'timeout');
  });

  test('audit envelope fields preserved through lifecycle', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator: opus,
      callbackTo: opus,
      targets: [codex],
      question: 'audit test',
      timeoutMinutes: 8,
      triggerType: 'design_review',
      searchEvidenceRefs: ['ref-1', 'ref-2'],
    });
    orch.start(req.id);
    orch.recordResponse(req.id, codex, 'done');

    const result = orch.getResult(req.id);
    assert.equal(result.request.triggerType, 'design_review');
    assert.deepEqual(result.request.searchEvidenceRefs, ['ref-1', 'ref-2']);
    assert.equal(result.request.initiator, opus);
    assert.equal(result.request.callbackTo, opus);
  });

  test('overrideReason preserved in request', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator: opus,
      callbackTo: opus,
      targets: [codex],
      question: 'urgent question',
      timeoutMinutes: 8,
      overrideReason: '紧急架构决策，无暇搜索',
    });

    const result = orch.getResult(req.id);
    assert.equal(result.request.overrideReason, '紧急架构决策，无暇搜索');
  });

  test('concurrent multi-mentions in different threads are independent', () => {
    const req1 = orch.create({
      threadId: 'thread1',
      initiator: opus,
      callbackTo: opus,
      targets: [codex],
      question: 'q1',
      timeoutMinutes: 8,
    });
    const req2 = orch.create({
      threadId: 'thread2',
      initiator: opus,
      callbackTo: opus,
      targets: [codex],
      question: 'q2',
      timeoutMinutes: 8,
    });

    orch.start(req1.id);
    orch.start(req2.id);

    // Complete thread1, thread2 still running
    orch.recordResponse(req1.id, codex, 'answer1');
    assert.equal(orch.getStatus(req1.id), 'done');
    assert.equal(orch.getStatus(req2.id), 'running');

    // Anti-cascade: codex is still active target in thread2
    assert.equal(orch.isActiveTarget('thread1', codex), false);
    assert.equal(orch.isActiveTarget('thread2', codex), true);
  });
});
