import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSkillConsumptionTools } from '../dist/tools/skill-consumption-tools.js';

test('skill consumption tools prepare revision binding, invoke the real consumer, and dismiss explicitly', async () => {
  const calls = [];
  const callbackPost = async (path, body) => {
    calls.push({ path, body });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  };
  const toolset = createSkillConsumptionTools(callbackPost);

  await toolset.handlePrepareSkillConsumption({ skillId: 'workspace-navigator' });
  await toolset.handleOpenWithWorkspaceNavigator({
    handle: 'prepared-handle',
    path: 'docs/VISION.md',
    worktreeId: 'cat-cafe',
    line: 12,
    threadId: 'thread-receipt',
  });
  await toolset.handleDismissSkillConsumption({
    handle: 'second-prepared-handle',
    reason: 'outside_skill_scope',
  });
  const assetVersionRef = {
    ownerFeatureId: 'F100',
    ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
    version: 'a'.repeat(64),
    assetKind: 'skill',
    assetId: 'cat-cafe-skills/request-review/SKILL.md',
  };
  await toolset.handlePrepareRequestReviewConsumption({
    assetVersionRef,
    reviewerCatId: 'codex-terra',
    reviewSubjectRef: 'pr:owner/cat-cafe#4512',
    reviewedHeadSha: 'b'.repeat(40),
    acceptedSourceRef: 'docs/features/F314-development-episode-alignment-experiment.md',
    acceptedRevision: 'c'.repeat(40),
  });
  await toolset.handleBindRequestReviewConsumption({ handle: 'request-review-handle' });
  await toolset.handleRecordRequestReviewConsumption({
    handle: 'request-review-handle',
    reviewMessageId: 'message-review',
  });
  await toolset.handleDismissRequestReviewConsumption({
    handle: 'request-review-dismiss-handle',
    reason: 'route_replaced',
  });
  await toolset.handleRecordRequestReviewOwnerFact({
    fact: {
      type: 'evidence',
      proposalId: 'proposal-f100-1',
      assetVersionRef,
      role: 'comparison_baseline',
      evidenceRef: { ownerFeatureId: 'F192', ownerStateRef: 'evidence:baseline' },
      proofRef: { ownerFeatureId: 'F267', ownerStateRef: 'proof:baseline' },
      status: 'verified',
    },
  });

  assert.deepEqual(calls[0], {
    path: '/api/callbacks/skill-consumption/prepare',
    body: { skillId: 'workspace-navigator' },
  });
  assert.deepEqual(calls[1], {
    path: '/api/workspace/navigate',
    body: {
      skillConsumptionHandle: 'prepared-handle',
      path: 'docs/VISION.md',
      action: 'open',
      worktreeId: 'cat-cafe',
      line: 12,
      threadId: 'thread-receipt',
    },
  });
  assert.equal(calls[2].path, '/api/callbacks/skill-consumption/dismiss');
  assert.equal(calls[2].body.handle, 'second-prepared-handle');
  assert.equal(calls[2].body.reason, 'outside_skill_scope');
  assert.deepEqual(calls[3], {
    path: '/api/callbacks/request-review-consumption/prepare',
    body: {
      assetVersionRef,
      reviewerCatId: 'codex-terra',
      reviewSubjectRef: 'pr:owner/cat-cafe#4512',
      reviewedHeadSha: 'b'.repeat(40),
      acceptedSourceRef: 'docs/features/F314-development-episode-alignment-experiment.md',
      acceptedRevision: 'c'.repeat(40),
    },
  });
  assert.deepEqual(calls[4], {
    path: '/api/callbacks/request-review-consumption/bind',
    body: { handle: 'request-review-handle' },
  });
  assert.deepEqual(calls[5], {
    path: '/api/callbacks/request-review-consumption/record',
    body: { handle: 'request-review-handle', reviewMessageId: 'message-review' },
  });
  assert.deepEqual(calls[6], {
    path: '/api/callbacks/request-review-consumption/dismiss',
    body: { handle: 'request-review-dismiss-handle', reason: 'route_replaced' },
  });
  assert.equal(calls[7].path, '/api/callbacks/request-review-owner/facts');
  assert.equal(calls[7].body.type, 'evidence');
  assert.deepEqual(
    toolset.tools.map((tool) => tool.name),
    [
      'cat_cafe_prepare_skill_consumption',
      'cat_cafe_record_request_review_owner_fact',
      'cat_cafe_open_with_workspace_navigator',
      'cat_cafe_dismiss_skill_consumption',
      'cat_cafe_prepare_request_review_consumption',
      'cat_cafe_bind_request_review_consumption',
      'cat_cafe_record_request_review_consumption',
      'cat_cafe_dismiss_request_review_consumption',
    ],
  );
  assert.equal(
    toolset.tools.some((tool) => tool.name.includes('apply')),
    false,
    'no self-attested apply setter exists',
  );
});

test('skill consumption tool descriptions refuse task-success causality and unsupported carriers', () => {
  const toolset = createSkillConsumptionTools(async () => ({ content: [] }));
  const combined = toolset.tools.map((tool) => tool.description).join('\n');
  assert.match(combined, /revision/i);
  assert.match(combined, /invocation/i);
  assert.match(combined, /NOT for/i);
  assert.match(combined, /agent-key.*unsupported/i);
  assert.match(combined, /task success/i);
  assert.match(combined, /does not prove.*package.*read/i);
  assert.match(combined, /strict author invocation.*origin/i);
});

test('request-review consumption receipts and owner Program facts retain separate governance subjects', () => {
  const toolset = createSkillConsumptionTools(async () => ({ content: [] }));
  const byName = new Map(toolset.tools.map((tool) => [tool.name, tool]));
  const consumptionAdmissionRef = 'file:docs/architecture/skill-consumption-receipt-contract.md';

  for (const name of [
    'cat_cafe_prepare_request_review_consumption',
    'cat_cafe_bind_request_review_consumption',
    'cat_cafe_record_request_review_consumption',
    'cat_cafe_dismiss_request_review_consumption',
  ]) {
    const tool = byName.get(name);
    assert.equal(tool?.policy.resourceFamily, 'skill-consumption-receipt', name);
    assert.equal(tool?.policy.standaloneReason.admissionRef, consumptionAdmissionRef, name);
  }

  const ownerFact = byName.get('cat_cafe_record_request_review_owner_fact');
  assert.equal(ownerFact?.policy.resourceFamily, 'evolution-program');
  assert.equal(
    ownerFact?.policy.standaloneReason.admissionRef,
    'file:docs/features/F311-capability-evolution-workspace.md',
  );
});

test('carrier profile projection exposes receipts only to full invocation MCP', async () => {
  const { buildCollabTools } = await import('../dist/server-toolsets.js');
  const receiptNames = new Set([
    'cat_cafe_prepare_skill_consumption',
    'cat_cafe_open_with_workspace_navigator',
    'cat_cafe_dismiss_skill_consumption',
    'cat_cafe_prepare_request_review_consumption',
    'cat_cafe_bind_request_review_consumption',
    'cat_cafe_record_request_review_consumption',
    'cat_cafe_dismiss_request_review_consumption',
    'cat_cafe_record_request_review_owner_fact',
  ]);
  const projected = (env) => new Set(buildCollabTools(env).map((tool) => tool.name));

  for (const name of receiptNames) assert.equal(projected({ readonly: false }).has(name), true);
  for (const env of [
    { readonly: true },
    { readonly: true, hasAgentKey: true, agentKeyUnion: true },
    { desktopMode: 'fable-phase0' },
    { desktopMode: 'cloud-pro-phase0' },
  ]) {
    for (const name of receiptNames) {
      assert.equal(projected(env).has(name), false, `${name} must be absent for ${JSON.stringify(env)}`);
    }
  }
});
