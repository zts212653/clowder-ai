import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { humanChoiceBody, objectBody, successBody } from './helpers/capability-evolution-preparation-bodies.js';

describe('F311 preparation saga recovery and invalidation', () => {
  let EvolutionProgramService;
  let EvolutionProgramPreparationService;
  let MemoryEvolutionProgramEventLog;
  let MessageStore;
  let ThreadStore;
  let eventLog;
  let messageStore;
  let threadStore;
  let thread;
  let invocation;
  let programService;
  let service;

  before(async () => {
    ({ EvolutionProgramService } = await import('../dist/infrastructure/capability-evolution/program-service.js'));
    ({ EvolutionProgramPreparationService } = await import(
      '../dist/infrastructure/capability-evolution/program-preparation-service.js'
    ));
    const { evolutionEventIdentityDigest } = await import(
      '../dist/infrastructure/capability-evolution/program-event-log.js'
    );
    MemoryEvolutionProgramEventLog = class {
      events = new Map();

      async append(envelope) {
        const entries = this.events.get(envelope.programId) ?? [];
        const existing = entries.find(
          (entry) => entry.eventId === envelope.eventId || entry.clientMessageId === envelope.clientMessageId,
        );
        if (existing) {
          return evolutionEventIdentityDigest(existing) === evolutionEventIdentityDigest(envelope)
            ? { outcome: 'duplicate' }
            : { outcome: 'idempotency_collision' };
        }
        if (entries.length !== envelope.expectedSequence) {
          return { outcome: 'conflict', actualSequence: entries.length };
        }
        this.events.set(envelope.programId, [...entries, envelope]);
        return { outcome: 'appended', sequence: entries.length + 1 };
      }

      async read(programId) {
        return [...(this.events.get(programId) ?? [])];
      }

      async listProgramIds(workspaceId) {
        return [...this.events.entries()]
          .filter(([, events]) => events[0]?.event?.workspaceId === workspaceId)
          .map(([programId]) => programId);
      }
    };
    ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
    ({ ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js'));
  });

  function createPreparation(messages = messageStore) {
    return new EvolutionProgramPreparationService({
      eventLog,
      projectProgram: (events) => programService.project(events),
      now: () => '2026-09-09T12:00:00.000Z',
      dependencies: {
        messageStore: messages,
        threadStore,
        invocationReader: { peekRecord: async () => invocation },
      },
    });
  }

  async function createProgram() {
    return programService.create({
      workspaceId: 'user:operator',
      targetRef: { ownerFeatureId: 'F311', ownerStateRef: 'capability:pm-agent-recovery' },
      clientMessageId: 'recovery-create',
      actorRef: 'cat:codex-sol',
      originRef: `thread:${thread.id}:invocation:${invocation.invocationId}:message:recovery-create`,
    });
  }

  function submit(programId, overrides = {}) {
    return {
      programId,
      expectedSequence: 1,
      clientMessageId: 'recovery-submit',
      principal: { kind: 'invocation', ...invocation },
      section: 'object_map',
      title: '可进化对象',
      expectedCurrentSubmissionRef: null,
      dependsOn: [],
      body: objectBody(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    eventLog = new MemoryEvolutionProgramEventLog();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    thread = await threadStore.create('operator', 'Recovery', '/repo');
    invocation = {
      invocationId: 'inv-recovery',
      userId: 'operator',
      catId: 'codex-sol',
      threadId: thread.id,
      state: 'active',
    };
    programService = new EvolutionProgramService({ eventLog });
    service = createPreparation();
  });

  function humanInput(overrides = {}) {
    const userId = overrides.userId ?? 'operator';
    return messageStore.append({
      userId,
      from: { kind: 'user', userId },
      threadId: thread.id,
      content: '保留当前预算，本轮继续比较路由策略。',
      mentions: [],
      timestamp: 1,
      ...overrides,
    });
  }

  function createCrashingPreparation() {
    return createPreparation({
      getById: (...args) => messageStore.getById(...args),
      getByIdempotencyKey: (...args) => messageStore.getByIdempotencyKey(...args),
      appendIdempotent: () => {
        throw new Error('simulated F117 outage after Program CAS');
      },
    });
  }

  it('persists a human choice as a new revision, preserves history, and invalidates a recalled input on reread', async () => {
    const programId = (await createProgram()).projection.program.programId;
    const first = await service.submitPreparation(submit(programId));
    const old = first.projection.preparation.sections.object_map.current;
    const input = humanInput();
    const second = await service.submitPreparation(
      submit(programId, {
        expectedSequence: 2,
        expectedCurrentSubmissionRef: old.ref,
        clientMessageId: 'human-choice',
        body: humanChoiceBody(input, thread.id),
      }),
    );
    const view = second.projection.preparation.sections.object_map;
    assert.equal(view.current.submission.authorCatId, 'codex-sol');
    assert.equal(view.current.inputSources[0].status, 'available');
    assert.equal(view.current.inputSources[0].author, 'human');
    assert.equal(view.current.inputSources[0].messageId, input.id);
    assert.deepEqual(view.history[0].submission, old.submission);
    assert.deepEqual((await createPreparation().get(programId)).preparation, second.projection.preparation);
    messageStore.softDelete(input.id, 'operator');
    const reread = (await service.get(programId)).preparation.sections.object_map.current;
    assert.equal(reread.inputSources[0].status, 'unavailable');
    assert.deepEqual(reread.submission, view.current.submission, 'immutable historical statement survives lost input');
  });

  it('rejects forged, wrong-author, cross-workspace and unavailable human input before any commit', async () => {
    const programId = (await createProgram()).projection.program.programId;
    for (const overrides of [
      { from: { kind: 'agent', catId: 'codex-terra' } },
      { userId: 'another-user' },
      { origin: 'callback' },
      { sourceParseFailure: true },
      { visibility: 'whisper' },
      { deletedAt: 1 },
      { recall: { recalledAt: 1 } },
    ]) {
      const input = humanInput(overrides);
      await assert.rejects(
        () =>
          service.submitPreparation(
            submit(programId, {
              clientMessageId: `forged-${input.id}`,
              body: humanChoiceBody(input, thread.id),
            }),
          ),
        (error) => error?.code === 'preparation_actor_invalid',
      );
      assert.equal((await eventLog.read(programId)).length, 1);
    }
    await assert.rejects(
      () =>
        service.submitPreparation(
          submit(programId, {
            body: humanChoiceBody({ id: 'not-a-real-message' }, thread.id),
          }),
        ),
      (error) => error?.code === 'preparation_actor_invalid',
    );
  });

  it('keeps a missing evidence read separate from the submitted GT validity statement', async () => {
    const programId = (await createProgram()).projection.program.programId;
    const source = humanInput();
    const ref = { ownerFeatureId: 'F117', ownerStateRef: `message:${source.id}` };
    const body = {
      kind: 'measurement_plan',
      summary: '多渠道取证',
      conditions: [],
      unknowns: [],
      nextAction: '逐条核查',
      gtSources: [
        {
          sourceKey: 'case',
          category: 'business_fact',
          label: '模拟与回访',
          collection: { state: 'collected', method: '配对模拟 + 人的回访', sourceRef: ref },
          validity: { state: 'bounded', detail: '已核已发生的案例', validFor: '只有此案例', proofRefs: [ref] },
          missingOrDisputed: [],
          cost: { payer: '项目维护', detail: '既有预算' },
        },
      ],
      comparison: {
        unit: '完整案例',
        primaryVariable: '局部路由',
        controls: [],
        developmentEvidence: '已公开',
        independentHoldout: '尚无',
        repeatability: '固定输入',
      },
    };
    const result = await service.submitPreparation(submit(programId, { section: 'measurement_plan', body }));
    const current = result.projection.preparation.sections.measurement_plan.current;
    assert.equal(current.evidenceSources[0].status, 'available');
    messageStore.softDelete(source.id, 'operator');
    const reread = (await service.get(programId)).preparation.sections.measurement_plan.current;
    assert.equal(reread.evidenceSources[0].status, 'unavailable');
    assert.deepEqual(reread.submission, current.submission);
  });

  it('shows an event-first interruption and heals the same command exactly once', async () => {
    const programId = (await createProgram()).projection.program.programId;
    const crashing = createCrashingPreparation();
    const command = submit(programId);
    await assert.rejects(() => crashing.submitPreparation(command), /simulated F117 outage/);
    const interrupted = (await crashing.get(programId)).preparation.sections.object_map.current;
    assert.equal(interrupted.status, 'materializing');
    assert.equal(interrupted.clientMessageId, command.clientMessageId);
    assert.equal(messageStore.getRecent(10, 'operator').length, 0);

    const recovered = await service.submitPreparation(command);
    assert.equal(recovered.outcome, 'recovered');
    assert.equal(recovered.projection.preparation.sections.object_map.current.status, 'submitted');
    assert.equal((await service.submitPreparation(command)).outcome, 'duplicate');
    assert.equal(messageStore.getRecent(10, 'operator').length, 1);
  });

  for (const loss of ['delete']) {
    it(`recovers the committed human-backed body after a crash and input ${loss}`, async () => {
      const programId = (await createProgram()).projection.program.programId;
      const input = humanInput({ deliveryStatus: 'queued' });
      assert.equal(messageStore.markDelivered(input.id, 1).deliveryTransitioned, true);
      const command = submit(programId, { body: humanChoiceBody(input, thread.id) });
      await assert.rejects(() => createCrashingPreparation().submitPreparation(command), /simulated F117 outage/);
      const committed = (await eventLog.read(programId))[1];
      messageStore.softDelete(input.id, 'operator');

      const recovered = await createPreparation().submitPreparation(command);
      const current = recovered.projection.preparation.sections.object_map.current;
      assert.equal(recovered.outcome, 'recovered');
      assert.equal(current.status, 'submitted');
      assert.deepEqual(current.ref, committed.event.submissionRef);
      assert.deepEqual(current.submission.body, command.body);
      assert.equal(current.inputSources[0].status, 'unavailable');
      assert.equal((await service.submitPreparation(command)).outcome, 'duplicate');
      assert.equal((await eventLog.read(programId)).length, 2);
    });
  }

  it('rejects a changed retry body before materializing a committed event with lost input', async () => {
    const programId = (await createProgram()).projection.program.programId;
    const input = humanInput();
    const command = submit(programId, { body: humanChoiceBody(input, thread.id) });
    await assert.rejects(() => createCrashingPreparation().submitPreparation(command), /simulated F117 outage/);
    messageStore.softDelete(input.id, 'operator');
    await assert.rejects(
      () => service.submitPreparation({ ...command, body: { ...command.body, summary: 'Changed retry body' } }),
      (error) => error?.code === 'idempotency_collision',
    );
    assert.equal((await eventLog.read(programId)).length, 2);
    assert.equal(messageStore.getRecent(10, 'operator').length, 0);
    assert.equal((await service.get(programId)).preparation.sections.object_map.current.status, 'materializing');
  });

  it('rejects identity reuse with a different body and exposes a deleted source as unavailable', async () => {
    const programId = (await createProgram()).projection.program.programId;
    const input = submit(programId);
    const submitted = await service.submitPreparation(input);
    await assert.rejects(
      () => service.submitPreparation({ ...input, body: objectBody('Different body') }),
      (error) => error?.code === 'idempotency_collision',
    );
    const messageId = submitted.projection.preparation.sections.object_map.current.messageId;
    messageStore.softDelete(messageId, 'operator');
    const missing = await service.get(programId);
    assert.equal(missing.preparation.sections.object_map.current.status, 'source_unavailable');
    assert.equal(missing.preparation.sections.object_map.current.submission, undefined);
  });

  it('derives needs_update when an exact upstream dependency is superseded', async () => {
    const programId = (await createProgram()).projection.program.programId;
    const objectV1 = await service.submitPreparation(submit(programId, { clientMessageId: 'object-v1' }));
    const refV1 = objectV1.projection.preparation.sections.object_map.current.ref;
    await service.submitPreparation({
      ...submit(programId),
      expectedSequence: 2,
      clientMessageId: 'success-v1',
      section: 'success_contract',
      title: '好坏规约',
      dependsOn: [refV1],
      body: successBody(),
    });
    await service.submitPreparation(
      submit(programId, {
        expectedSequence: 3,
        clientMessageId: 'object-v2',
        expectedCurrentSubmissionRef: refV1,
        body: objectBody('Changed candidates'),
      }),
    );
    const stale = await service.get(programId);
    assert.equal(stale.preparation.sections.success_contract.current.status, 'needs_update');
    assert.deepEqual(stale.preparation.sections.success_contract.current.staleDependencies, [refV1]);
  });
});
