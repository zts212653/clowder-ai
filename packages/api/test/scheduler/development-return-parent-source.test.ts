import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThreadProposal } from '@cat-cafe/shared';
import type { StoredMessage } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import { DevelopmentReturnService } from '../../src/infrastructure/scheduler/development-return/DevelopmentReturnService.js';
import { RunLedger } from '../../src/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../../src/infrastructure/scheduler/TaskRunnerV2.js';
import { createDevelopmentReturnFixture } from '../helpers/development-return-fixture.js';

const invalidParentBoundRelations: Array<{
  label: string;
  proposal?: (proposal: ThreadProposal) => ThreadProposal;
  source?: (source: StoredMessage, proposal: ThreadProposal) => StoredMessage;
}> = [
  {
    label: 'proposal parent drift',
    proposal: (proposal) => ({ ...proposal, parentThreadId: 'thread-other-parent' }),
  },
  {
    label: 'Task scope drift',
    proposal: (proposal) => ({
      ...proposal,
      approvedDevelopmentScope: {
        ...proposal.approvedDevelopmentScope,
        acceptedRevision: 'b'.repeat(40),
      } as NonNullable<ThreadProposal['approvedDevelopmentScope']>,
    }),
  },
  {
    label: 'approval tenant drift',
    proposal: (proposal) => ({ ...proposal, approvedBy: 'other-user' }),
  },
  {
    label: 'cat-authored source',
    source: (source) => ({ ...source, catId: 'sonnet' }),
  },
  {
    label: 'source newer than approval',
    source: (source, proposal) => ({ ...source, timestamp: (proposal.approvedAt ?? 0) + 1 }),
  },
  {
    label: 'source thread drift',
    source: (source) => ({ ...source, threadId: 'thread-other-source' }),
  },
];

test('Task owner registers final return for an exact approved child sourced in another thread', async (t) => {
  const fixture = await createDevelopmentReturnFixture(t, { separateProposalSource: true });
  assert.notEqual(fixture.proposalSourceThread.id, fixture.actor.threadId);

  const registration = await fixture.service.register(fixture.actor, fixture.input, 'strict');
  assert.equal(registration.ownerThreadId, fixture.actor.threadId);
  assert.equal(registration.executionThreadId, fixture.child.id);
  assert.equal(registration.sourceActionRef, `message:${fixture.proposalSource.id}`);
  assert.equal(registration.status, 'waiting');
});

test('Task owner registers an approved A2A-triggered child against the original human Task authority', async (t) => {
  const fixture = await createDevelopmentReturnFixture(t, { catAuthoredProposalSource: true });
  assert.equal(fixture.proposalSource.catId, fixture.actor.catId);
  assert.equal(fixture.input.sourceActionRef, `message:${fixture.source.id}`);

  const registration = await fixture.service.register(fixture.actor, fixture.input, 'strict');

  assert.equal(registration.proposalId, fixture.child.createdFromProposalId);
  assert.equal(registration.executionThreadId, fixture.child.id);
  assert.equal(registration.sourceActionRef, `message:${fixture.source.id}`);
  assert.equal(registration.status, 'waiting');
  const row = fixture.db
    .prepare(`SELECT enabled, development_return_json, reviewed_development_return_json,
      successor_development_return_json, parent_bound_development_return_json
      FROM dynamic_task_defs WHERE id = ?`)
    .get(registration.registrationId) as {
    enabled: number;
    development_return_json: string | null;
    reviewed_development_return_json: string | null;
    successor_development_return_json: string | null;
    parent_bound_development_return_json: string | null;
  };
  assert.equal(row.enabled, 0);
  assert.equal(row.development_return_json, null);
  assert.equal(row.reviewed_development_return_json, null);
  assert.equal(row.successor_development_return_json, null);
  assert.ok(row.parent_bound_development_return_json, 'older binaries cannot consume the composite relation');
});

const invalidOwnerTriggerRelations = [
  'unrouted peer trigger',
  'unapproved proposal',
  'unrelated human source',
  'proposal trigger supplied as human authority',
  'deleted proposal trigger',
] as const;

for (const scenario of invalidOwnerTriggerRelations) {
  test(`approved A2A-trigger relation rejects ${scenario}`, async (t) => {
    const fixture = await createDevelopmentReturnFixture(t, { catAuthoredProposalSource: true });
    const input = { ...fixture.input };
    switch (scenario) {
      case 'unrouted peer trigger':
        fixture.proposalSource.catId = 'sonnet';
        break;
      case 'unapproved proposal': {
        const get = fixture.proposals.get.bind(fixture.proposals);
        fixture.service.deps.proposals = {
          get: async (id) => {
            const proposal = get(id);
            return proposal && { ...proposal, status: 'pending' as const, approvedAt: undefined };
          },
        };
        break;
      }
      case 'unrelated human source': {
        const unrelated = fixture.messages.append({
          userId: fixture.actor.userId,
          from: { kind: 'user', userId: fixture.actor.userId },
          threadId: fixture.actor.threadId,
          content: 'Unrelated human instruction',
          mentions: [],
          timestamp: fixture.service.now(),
        });
        input.sourceActionRef = `message:${unrelated.id}`;
        break;
      }
      case 'proposal trigger supplied as human authority':
        input.sourceActionRef = `message:${fixture.proposalSource.id}`;
        break;
      case 'deleted proposal trigger':
        assert.ok(fixture.messages.softDelete(fixture.proposalSource.id, fixture.actor.userId));
        break;
    }

    await assert.rejects(fixture.service.register(fixture.actor, input, 'strict'));
    assert.equal(fixture.service.readForActor(fixture.actor).length, 0);
  });
}

for (const sourceMutation of ['trigger deleted', 'trigger edited', 'human deleted', 'human edited'] as const) {
  test(`A2A-triggered return retires when its ${sourceMutation}`, async (t) => {
    const fixture = await createDevelopmentReturnFixture(t, { catAuthoredProposalSource: true });
    const registration = await fixture.service.register(fixture.actor, fixture.input, 'strict');
    const target = sourceMutation.startsWith('trigger') ? fixture.proposalSource : fixture.source;
    if (sourceMutation.endsWith('deleted')) {
      assert.ok(fixture.messages.softDelete(target.id, fixture.actor.userId));
    } else {
      target.content = `${target.content} edited after approval`;
    }

    fixture.tick(20_000);
    await fixture.runner.triggerNow(registration.registrationId);

    assert.equal(fixture.service.read(registration.registrationId)?.status, 'retired');
    assert.equal(fixture.wakes.length, 0);
  });
}

test('legacy same-source return remains valid when its approved child was re-rooted elsewhere', async (t) => {
  const fixture = await createDevelopmentReturnFixture(t, { legacyReparentedChild: true });
  assert.equal(fixture.proposalSourceThread.id, fixture.actor.threadId);
  assert.notEqual(fixture.proposalParentThread.id, fixture.actor.threadId);

  const registration = await fixture.service.register(fixture.actor, fixture.input, 'strict');
  assert.equal(registration.executionThreadId, fixture.child.id);
  assert.equal(registration.status, 'waiting');
});

test('parent-bound source is fenced from older return readers and resumes on the current binary', async (t) => {
  const fixture = await createDevelopmentReturnFixture(t, { separateProposalSource: true });
  const registration = await fixture.service.register(fixture.actor, fixture.input, 'strict');
  const row = fixture.db
    .prepare(`SELECT enabled, development_return_json, reviewed_development_return_json,
      successor_development_return_json, parent_bound_development_return_json
      FROM dynamic_task_defs WHERE id = ?`)
    .get(registration.registrationId) as {
    enabled: number;
    development_return_json: string | null;
    reviewed_development_return_json: string | null;
    successor_development_return_json: string | null;
    parent_bound_development_return_json: string | null;
  };
  assert.equal(row.enabled, 0);
  assert.equal(row.development_return_json, null);
  assert.equal(row.reviewed_development_return_json, null);
  assert.equal(row.successor_development_return_json, null);
  assert.ok(row.parent_bound_development_return_json);
  const oldVisible = fixture.db
    .prepare(`SELECT id FROM dynamic_task_defs WHERE id = ? AND
      (enabled = 1 OR reviewed_development_return_json IS NOT NULL
        OR successor_development_return_json IS NOT NULL)`)
    .get(registration.registrationId);
  assert.equal(oldVisible, undefined);

  fixture.runner.stop();
  const definitions = new DynamicTaskStore(fixture.db);
  const runner = new TaskRunnerV2({
    ledger: new RunLedger(fixture.db),
    dynamicTaskStore: definitions,
    logger: { info() {}, error() {} },
  });
  t.after(() => runner.stop());
  const resumed = new DevelopmentReturnService({ ...fixture.service.deps, definitions, runner });
  assert.equal(runner.hydrateDynamic(definitions, { get: () => resumed.template }), 1);
  fixture.tick(20_000);
  await runner.triggerNow(registration.registrationId);
  assert.equal(resumed.read(registration.registrationId)?.status, 'delivered');
  assert.equal(fixture.wakes.length, 1);
});

test('deleting the cross-thread human source retires the parent-bound return without a wake', async (t) => {
  const fixture = await createDevelopmentReturnFixture(t, { separateProposalSource: true });
  const registration = await fixture.service.register(fixture.actor, fixture.input, 'strict');
  assert.ok(fixture.messages.softDelete(fixture.proposalSource.id, fixture.actor.userId));

  fixture.tick(20_000);
  await fixture.runner.triggerNow(registration.registrationId);

  assert.equal(fixture.wakes.length, 0);
  assert.equal(fixture.service.read(registration.registrationId)?.status, 'retired');
});

for (const scenario of invalidParentBoundRelations) {
  test(`parent-bound return rejects ${scenario.label}`, async (t) => {
    const fixture = await createDevelopmentReturnFixture(t, { separateProposalSource: true });
    const proposalId = fixture.child.createdFromProposalId;
    assert.ok(proposalId);
    const canonicalProposal = fixture.proposals.get(proposalId);
    assert.ok(canonicalProposal);
    const canonicalSource = fixture.messages.getById(fixture.proposalSource.id);
    assert.ok(canonicalSource);
    fixture.service.deps.proposals = {
      get: async (id) =>
        id === proposalId && scenario.proposal ? scenario.proposal(canonicalProposal) : fixture.proposals.get(id),
    };
    fixture.service.deps.messages = {
      getById: async (id) =>
        id === canonicalSource.id && scenario.source
          ? scenario.source(canonicalSource, canonicalProposal)
          : fixture.messages.getById(id),
      append: (input) => fixture.messages.append(input),
    };

    await assert.rejects(fixture.service.register(fixture.actor, fixture.input, 'strict'));
  });
}
