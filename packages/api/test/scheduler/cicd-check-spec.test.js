import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('CiCdCheckTaskSpec', () => {
  it('has correct id and profile', async () => {
    const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const spec = createCiCdCheckTaskSpec({
      prTrackingStore: { listAll: async () => [] },
      cicdRouter: { route: async () => ({ kind: 'noop' }) },
      log: { info: () => {}, error: () => {}, warn: () => {} },
    });
    assert.equal(spec.id, 'cicd-check');
    assert.equal(spec.profile, 'poller');
    assert.equal(spec.trigger.ms, 60_000);
  });

  it('gate returns run:false when no tracked PRs', async () => {
    const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const spec = createCiCdCheckTaskSpec({
      prTrackingStore: { listAll: async () => [] },
      cicdRouter: { route: async () => ({ kind: 'noop' }) },
      log: { info: () => {}, error: () => {}, warn: () => {} },
    });
    const result = await spec.admission.gate({ taskId: 'cicd-check', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false);
  });

  it('gate returns run:true with per-PR workItems when PRs are tracked', async () => {
    const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const mockPrs = [
      { repoFullName: 'a/b', prNumber: 1, ciTrackingEnabled: true },
      { repoFullName: 'c/d', prNumber: 42, ciTrackingEnabled: true },
    ];
    const spec = createCiCdCheckTaskSpec({
      prTrackingStore: { listAll: async () => mockPrs },
      cicdRouter: { route: async () => ({ kind: 'noop' }) },
      log: { info: () => {}, error: () => {}, warn: () => {} },
    });
    const result = await spec.admission.gate({ taskId: 'cicd-check', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems.length, 2);
    assert.equal(result.workItems[0].subjectKey, 'pr-a/b#1');
    assert.equal(result.workItems[1].subjectKey, 'pr-c/d#42');
  });

  it('gate filters out ciTrackingEnabled=false', async () => {
    const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const mockPrs = [
      { repoFullName: 'a/b', prNumber: 1, ciTrackingEnabled: true },
      { repoFullName: 'c/d', prNumber: 2, ciTrackingEnabled: false },
    ];
    const spec = createCiCdCheckTaskSpec({
      prTrackingStore: { listAll: async () => mockPrs },
      cicdRouter: { route: async () => ({ kind: 'noop' }) },
      log: { info: () => {}, error: () => {}, warn: () => {} },
    });
    const result = await spec.admission.gate({ taskId: 'cicd-check', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems.length, 1);
  });
});
