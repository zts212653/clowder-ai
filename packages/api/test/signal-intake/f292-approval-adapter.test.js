import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { F292ApprovalAdapter } from '../../dist/domains/approval-hub/adapters/F292ApprovalAdapter.js';
import { admissionHarness, publishInput } from './helpers.js';

describe('F292 Needs Me projection', () => {
  it('projects one event-origin card for unresolved truth and hides resolved truth', async () => {
    const admission = await admissionHarness();
    await admission.service.publish(admission.binding, publishInput());
    const adapter = new F292ApprovalAdapter(admission.intakes);

    const pending = await adapter.listPending('owner-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sourceFeatureId, 'F292');
    assert.equal(pending[0].decisionMode, 'meeting-intake');
    assert.equal(pending[0].navigation.state, 'legacy_unanchored');
    assert.deepEqual(pending[0].detail.unresolved, ['speakers', 'context', 'destination', 'outputs']);

    const current = await admission.intakes.get('intake-1');
    await admission.intakes.compareAndSet('intake-1', current.revision, {
      ...current,
      judgmentState: 'auto_resolved',
      executionState: 'succeeded',
      unresolved: [],
      revision: current.revision + 1,
      updatedAt: 11_000,
    });
    assert.deepEqual(await adapter.listPending('owner-1'), []);
    assert.equal((await adapter.listSettled('owner-1'))[0].status, 'approved');
  });

  it('does not mislabel hidden auto-resolved work as settled before execution succeeds', async () => {
    const admission = await admissionHarness();
    await admission.service.publish(admission.binding, publishInput());
    const current = await admission.intakes.get('intake-1');
    await admission.intakes.compareAndSet('intake-1', current.revision, {
      ...current,
      judgmentState: 'auto_resolved',
      executionState: 'queued',
      unresolved: [],
      revision: current.revision + 1,
      updatedAt: 11_000,
    });

    const adapter = new F292ApprovalAdapter(admission.intakes);
    assert.deepEqual(await adapter.listPending('owner-1'), []);
    assert.deepEqual(await adapter.listSettled('owner-1'), []);
  });

  it('keeps a single repair card visible even after judgment is resolved', async () => {
    const admission = await admissionHarness();
    await admission.service.publish(admission.binding, publishInput());
    const current = await admission.intakes.get('intake-1');
    await admission.intakes.compareAndSet('intake-1', current.revision, {
      ...current,
      judgmentState: 'confirmed',
      executionState: 'failed',
      healthState: 'degraded',
      unresolved: [],
      repair: { code: 'execution_failed', action: 'retry', observedAt: 11_000 },
      revision: current.revision + 1,
      updatedAt: 11_000,
    });

    const pending = await new F292ApprovalAdapter(admission.intakes).listPending('owner-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].detail.repair.action, 'retry');
  });
});
