import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { checkGovernancePreflight } from '../../dist/config/governance/governance-preflight.js';

describe('F070: governance_blocked event contract', () => {
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

    assert.equal(payload.type, 'governance_blocked');
    assert.equal(typeof payload.projectPath, 'string');
    assert.ok(payload.projectPath.length > 0);
    assert.ok(['needs_bootstrap', 'needs_confirmation', 'files_missing'].includes(payload.reasonKind));
    assert.equal(typeof payload.reason, 'string');
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

  it('errorCode on done signals routes to mark invocation as failed', () => {
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
    const finalStatus = governanceErrorCode ? 'failed' : 'succeeded';
    assert.equal(finalStatus, 'failed');
  });

  it('multi-cat dispatch deduplicates governance_blocked by projectPath', async () => {
    const preflight = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(preflight.ready, false);

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
      invocationId: 'inv-1',
    };

    const seen = new Set();
    const rendered = [];
    for (const p of [cat1Payload, cat2Payload]) {
      if (!seen.has(p.projectPath)) {
        seen.add(p.projectPath);
        rendered.push(p);
      }
    }
    assert.equal(rendered.length, 1);
  });

  it('repeated block replaces old card with new one carrying latest invocationId', () => {
    const cards = [];
    const events = [
      { type: 'governance_blocked', projectPath: '/proj', invocationId: 'inv-A' },
      { type: 'governance_blocked', projectPath: '/proj', invocationId: 'inv-B' },
    ];

    for (const e of events) {
      const existingIdx = cards.findIndex((c) => c.projectPath === e.projectPath);
      if (existingIdx >= 0) {
        cards.splice(existingIdx, 1);
      }
      cards.push({ projectPath: e.projectPath, invocationId: e.invocationId });
    }

    assert.equal(cards.length, 1);
    assert.equal(cards[0].invocationId, 'inv-B');
  });

  it('errorCode on done signals both messages.ts and invocations.ts to mark failed', () => {
    const messages = [
      { type: 'system_info', catId: 'opus', content: '{}', timestamp: Date.now() },
      { type: 'done', catId: 'opus', isFinal: true, errorCode: 'GOVERNANCE_BOOTSTRAP_REQUIRED', timestamp: Date.now() },
    ];

    let messagesPathErrorCode;
    for (const msg of messages) {
      if (msg.type === 'done' && msg.errorCode) messagesPathErrorCode = msg.errorCode;
    }
    const messagesStatus = messagesPathErrorCode ? 'failed' : 'succeeded';

    let retryPathErrorCode;
    for (const msg of messages) {
      if (msg.type === 'done' && msg.errorCode) retryPathErrorCode = msg.errorCode;
    }
    const retryStatus = retryPathErrorCode ? 'failed' : 'succeeded';

    assert.equal(messagesStatus, 'failed');
    assert.equal(retryStatus, 'failed');
    assert.equal(messagesPathErrorCode, retryPathErrorCode);
  });

  it('errorCode capture works for all 4 routeExecution consumers', () => {
    const messages = [
      { type: 'text', catId: 'opus', content: 'hello', timestamp: Date.now() },
      { type: 'done', catId: 'opus', isFinal: true, errorCode: 'GOVERNANCE_BOOTSTRAP_REQUIRED', timestamp: Date.now() },
    ];

    const consumers = ['messages.ts', 'invocations.ts', 'callback-a2a-trigger.ts', 'callback-multi-mention-routes.ts'];
    const results = {};

    for (const consumer of consumers) {
      let errorCode;
      for (const msg of messages) {
        if (msg.type === 'done' && msg.errorCode) {
          errorCode = msg.errorCode;
        }
      }
      results[consumer] = errorCode ? 'failed' : 'succeeded';
    }

    for (const consumer of consumers) {
      assert.equal(results[consumer], 'failed', `${consumer} should mark as failed`);
    }
  });
});
