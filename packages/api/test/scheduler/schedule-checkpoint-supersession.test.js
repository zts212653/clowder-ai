import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fingerprintDynamicTaskDef } from '../../dist/infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { templateRegistry } from '../../dist/infrastructure/scheduler/templates/registry.js';
import {
  createDecisionFixture,
  createProposal,
  deleteProposal,
  OWNER,
  task,
} from './schedule-proposal-decision-fixture.js';

describe('schedule approval recovery after a newer operation', () => {
  let fixture, delivered;
  beforeEach(async () => {
    delivered = [];
    fixture = await createDecisionFixture({
      deliver: async (input) => {
        delivered.push(input);
        return 'delivered';
      },
    });
  });
  afterEach(async () => fixture.close());

  function stage(proposal) {
    fixture.store.create(proposal);
    fixture.anchor(proposal);
    fixture.store.claimForApproval(proposal.proposalId, Date.now());
  }

  async function approve(proposal) {
    fixture.store.create(proposal);
    fixture.anchor(proposal);
    assert.equal((await fixture.decide(proposal.proposalId, 'approve')).statusCode, 200);
  }

  async function settle(proposal) {
    const response = await fixture.decide(proposal.proposalId, 'approve');
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(fixture.store.getById(proposal.proposalId).status, 'approved');
    assert.equal(fixture.store.listPending(OWNER).length, 0);
    assert.equal((await fixture.decide(proposal.proposalId, 'approve')).statusCode, 409);
    const receipts = await fixture.messageStore.getByThread('thread-owner');
    assert.equal(
      receipts.filter((message) => message.content.includes(`定时提案 ${proposal.proposalId} 已批准`)).length,
      1,
    );
  }

  it('settles a committed update after an approved delete even if its template is gone', async (t) => {
    const original = task({ trigger: { type: 'interval', ms: 60_000 } });
    fixture.dynamicStore.insert(original);
    fixture.register(original);
    const update = createProposal({
      proposalId: 'interrupted-update',
      mutation: {
        kind: 'update',
        taskId: original.id,
        taskSnapshot: original,
        expectedFingerprint: fingerprintDynamicTaskDef(original),
        params: { ...original.params, message: 'committed update' },
      },
    });
    stage(update);
    fixture.store.applyUpdateEffect(update.proposalId, Date.now());
    await approve(deleteProposal(fixture.dynamicStore.getById(original.id)));
    t.mock.method(templateRegistry, 'get', () => null);
    await settle(update);
    assert.equal(fixture.dynamicStore.getById(original.id), null);
    assert.equal(fixture.runner.getTaskSummaries().length, 0);
    assert.equal(fixture.store.listAudit(OWNER).length, 1);
  });

  it('settles a committed create after an approved delete without recreating it', async () => {
    const create = createProposal();
    stage(create);
    fixture.store.applyCreateEffect(create.proposalId, Date.now());
    await approve(deleteProposal(fixture.dynamicStore.getById(create.mutation.task.id)));
    await settle(create);
    assert.equal(fixture.dynamicStore.getById(create.mutation.task.id), null);
    assert.equal(fixture.runner.getTaskSummaries().length, 0);
  });

  it('keeps an approved disabled create out of the runner', async () => {
    const create = createProposal({ mutation: { kind: 'create', task: task({ enabled: false }) } });
    await approve(create);
    assert.equal(fixture.dynamicStore.getById(create.mutation.task.id).enabled, false);
    assert.equal(fixture.runner.getTaskSummaries().length, 0);
  });

  it('settles a committed create after an approved pause without restarting the task', async () => {
    const create = createProposal({
      mutation: { kind: 'create', task: task({ trigger: { type: 'interval', ms: 60_000 } }) },
    });
    stage(create);
    fixture.store.applyCreateEffect(create.proposalId, Date.now());
    fixture.register(create.mutation.task);
    fixture.store.setTaskEnabledWithAudit(create.mutation.task.id, false, {
      auditId: 'later-pause',
      ownerUserId: OWNER,
      actorKind: 'cvo',
      actorId: OWNER,
      action: 'pause',
      taskId: create.mutation.task.id,
      detail: {},
      createdAt: Date.now(),
    });
    fixture.runner.unregister(create.mutation.task.id);
    await settle(create);
    assert.equal(fixture.dynamicStore.getById(create.mutation.task.id).enabled, false);
    assert.equal(fixture.runner.getTaskSummaries().length, 0);
  });

  it('settles a committed delete without unregistering an approved replacement', async () => {
    const original = task({ trigger: { type: 'interval', ms: 60_000 } });
    fixture.dynamicStore.insert(original);
    fixture.register(original);
    const deletion = deleteProposal(original);
    stage(deletion);
    fixture.store.applyDeleteEffect(deletion.proposalId, Date.now());
    fixture.runner.unregister(original.id);
    const replacement = task({ ...original, params: { ...original.params, message: 'replacement task' } });
    await approve(
      createProposal({ proposalId: 'replacement-create', mutation: { kind: 'create', task: replacement } }),
    );
    await settle(deletion);
    assert.deepEqual(fixture.dynamicStore.getById(original.id), replacement);
    await fixture.runner.triggerNow(original.id);
    assert.match(delivered[0].content, /replacement task/);
  });
});
