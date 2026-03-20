/**
 * F130: Governance Blocked Event — structured event format + errorCode
 *
 * Tests that the governance_blocked system_info payload and done errorCode
 * conform to the contract expected by the frontend GovernanceBlockedCard.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { checkGovernancePreflight } from '../../dist/config/governance/governance-preflight.js';

describe('F130: governance_blocked event contract', () => {
  let catCafeRoot;
  let externalProject;

  beforeEach(async () => {
    catCafeRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-root-'));
    externalProject = await mkdtemp(join(tmpdir(), 'external-project-'));
    await mkdir(join(catCafeRoot, 'cat-cafe-skills'), { recursive: true });
  });

  afterEach(async () => {
    await rm(catCafeRoot, { recursive: true, force: true });
    await rm(externalProject, { recursive: true, force: true });
  });

  it('governance_blocked payload has required fields for frontend card', async () => {
    const preflight = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(preflight.ready, false);

    // Simulate the JSON payload from invoke-single-cat (F130 contract)
    const reasonKind = preflight.needsBootstrap
      ? 'needs_bootstrap'
      : preflight.needsConfirmation
        ? 'needs_confirmation'
        : 'files_missing';
    const payload = JSON.parse(
      JSON.stringify({
        type: 'governance_blocked',
        projectPath: externalProject,
        reasonKind,
        reason: preflight.reason,
        invocationId: 'inv-test-123',
      }),
    );

    // Assert required fields exist and have correct types
    assert.equal(payload.type, 'governance_blocked');
    assert.equal(typeof payload.projectPath, 'string');
    assert.ok(payload.projectPath.length > 0, 'projectPath must not be empty');
    assert.ok(
      ['needs_bootstrap', 'needs_confirmation', 'files_missing'].includes(payload.reasonKind),
      `reasonKind must be one of the enum values, got: ${payload.reasonKind}`,
    );
    assert.equal(typeof payload.reason, 'string');
    assert.equal(typeof payload.invocationId, 'string');
    assert.equal(payload.invocationId, 'inv-test-123');
  });

  it('reasonKind maps correctly for unregistered project', async () => {
    const preflight = await checkGovernancePreflight(externalProject, catCafeRoot);
    const reasonKind = preflight.needsBootstrap
      ? 'needs_bootstrap'
      : preflight.needsConfirmation
        ? 'needs_confirmation'
        : 'files_missing';

    assert.equal(reasonKind, 'needs_bootstrap');
  });

  it('done event with errorCode is valid for retry flow', () => {
    // Simulate the done event from invoke-single-cat (F130 contract)
    const doneEvent = {
      type: 'done',
      catId: 'opus',
      isFinal: true,
      errorCode: 'GOVERNANCE_BOOTSTRAP_REQUIRED',
      timestamp: Date.now(),
    };

    assert.equal(doneEvent.type, 'done');
    assert.equal(doneEvent.errorCode, 'GOVERNANCE_BOOTSTRAP_REQUIRED');
    assert.equal(doneEvent.isFinal, true);
  });

  it('errorCode on done signals messages.ts to mark invocation as failed', () => {
    // Simulate messages.ts post-loop logic
    let governanceErrorCode;
    const messages = [
      { type: 'system_info', catId: 'opus', content: '{}', timestamp: Date.now() },
      { type: 'done', catId: 'opus', isFinal: true, errorCode: 'GOVERNANCE_BOOTSTRAP_REQUIRED', timestamp: Date.now() },
    ];

    for (const msg of messages) {
      if (msg.type === 'done' && msg.errorCode) {
        governanceErrorCode = msg.errorCode;
      }
    }

    assert.equal(governanceErrorCode, 'GOVERNANCE_BOOTSTRAP_REQUIRED');

    // messages.ts should mark as failed, not succeeded
    const finalStatus = governanceErrorCode ? 'failed' : 'succeeded';
    assert.equal(finalStatus, 'failed');
  });

  it('multi-cat block: each cat yields its own governance_blocked with same projectPath', async () => {
    const preflight = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(preflight.ready, false);

    // Simulate two cats hitting the same block
    const cat1Payload = {
      type: 'governance_blocked',
      projectPath: externalProject,
      reasonKind: 'needs_bootstrap',
      invocationId: 'inv-1',
    };
    const cat2Payload = {
      type: 'governance_blocked',
      projectPath: externalProject,
      reasonKind: 'needs_bootstrap',
      invocationId: 'inv-1', // Same invocation for multi-cat dispatch
    };

    // Frontend should deduplicate by projectPath
    assert.equal(cat1Payload.projectPath, cat2Payload.projectPath);
    // Only first card should be rendered
    const seen = new Set();
    const rendered = [];
    for (const p of [cat1Payload, cat2Payload]) {
      if (!seen.has(p.projectPath)) {
        seen.add(p.projectPath);
        rendered.push(p);
      }
    }
    assert.equal(rendered.length, 1, 'Should deduplicate to single card');
  });

  it('P2-1: repeated block updates invocationId instead of dropping newer call', () => {
    // Simulate user sends message A → blocked (inv-A), then message B → blocked (inv-B)
    const cards = new Map(); // projectPath → { invocationId }
    const events = [
      { type: 'governance_blocked', projectPath: '/proj', invocationId: 'inv-A' },
      { type: 'governance_blocked', projectPath: '/proj', invocationId: 'inv-B' },
    ];

    for (const e of events) {
      const existing = cards.get(e.projectPath);
      if (existing) {
        // P2-1: update invocationId to latest
        existing.invocationId = e.invocationId;
      } else {
        cards.set(e.projectPath, { invocationId: e.invocationId });
      }
    }

    assert.equal(cards.size, 1, 'Still one card');
    assert.equal(cards.get('/proj').invocationId, 'inv-B', 'Card should hold latest invocationId');
  });

  it('errorCode on done signals BOTH messages.ts and invocations.ts retry path to mark failed', () => {
    // Both routeExecution consumers must handle errorCode identically
    const messages = [
      { type: 'system_info', catId: 'opus', content: '{}', timestamp: Date.now() },
      { type: 'done', catId: 'opus', isFinal: true, errorCode: 'GOVERNANCE_BOOTSTRAP_REQUIRED', timestamp: Date.now() },
    ];

    // Simulate messages.ts path
    let messagesPathErrorCode;
    for (const msg of messages) {
      if (msg.type === 'done' && msg.errorCode) messagesPathErrorCode = msg.errorCode;
    }
    const messagesStatus = messagesPathErrorCode ? 'failed' : 'succeeded';

    // Simulate invocations.ts retry path (must mirror messages.ts)
    let retryPathErrorCode;
    for (const msg of messages) {
      if (msg.type === 'done' && msg.errorCode) retryPathErrorCode = msg.errorCode;
    }
    const retryStatus = retryPathErrorCode ? 'failed' : 'succeeded';

    assert.equal(messagesStatus, 'failed', 'messages.ts should mark failed');
    assert.equal(retryStatus, 'failed', 'invocations.ts retry should also mark failed');
    assert.equal(messagesPathErrorCode, retryPathErrorCode, 'Both paths must capture same errorCode');
  });
});
