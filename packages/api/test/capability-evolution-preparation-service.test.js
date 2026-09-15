import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = 'f311-preparation-service-test:';

describe('F311 production preparation service', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let EvolutionProgramService;
  let EvolutionProgramPreparationService;
  let RedisEvolutionProgramEventLog;
  let MessageStore;
  let ThreadStore;
  let redis;
  let eventLog;
  let messageStore;
  let threadStore;
  let invocationRecords;
  let service, programService;
  let thread;
  let tick;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F311PreparationService');
    ({ RedisEvolutionProgramEventLog } = await import(
      '../dist/infrastructure/capability-evolution/program-event-log.js'
    ));
    ({ EvolutionProgramService } = await import('../dist/infrastructure/capability-evolution/program-service.js'));
    ({ EvolutionProgramPreparationService } = await import(
      '../dist/infrastructure/capability-evolution/program-preparation-service.js'
    ));
    ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
    ({ ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js'));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
  });

  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  function createService(overrides = {}) {
    return new EvolutionProgramPreparationService({
      eventLog,
      projectProgram: (events) => programService.project(events),
      now: () => new Date(Date.parse('2026-09-09T08:00:00.000Z') + tick++ * 1_000).toISOString(),
      dependencies: {
        messageStore: overrides.messageStore ?? messageStore,
        threadStore,
        invocationReader: {
          peekRecord: async (invocationId) => invocationRecords.get(invocationId) ?? null,
        },
      },
    });
  }

  function principal(invocationId = 'inv-preparation', catId = 'codex-sol', threadId = thread.id) {
    return { kind: 'invocation', invocationId, userId: 'operator', catId, threadId };
  }

  function addInvocation(invocationId = 'inv-preparation', catId = 'codex-sol', threadId = thread.id) {
    invocationRecords.set(invocationId, {
      invocationId,
      userId: 'operator',
      catId,
      threadId,
      state: 'active',
    });
  }

  function objectMapBody(label = 'Prompt and policy') {
    const source = { ownerFeatureId: 'F117', ownerStateRef: 'message:source', version: 'v1' };
    return {
      kind: 'object_map',
      goalStatement: '让 PM Agent 专业地推进项目，只在必要时请人介入',
      summary: 'Several candidate causes remain open.',
      items: [
        {
          itemId: 'prompt-policy',
          label,
          scope: 'Decision and escalation policy.',
          why: 'It may shape autonomous progress and escalation quality.',
          modifiability: { state: 'modifiable', reason: 'Owned in this repository.', basisRefs: [source] },
          sourceRefs: [source],
          nextAction: 'Inspect the current version before choosing an intervention.',
        },
      ],
      unknowns: ['The dominant cause is not known.'],
      nextAction: 'Inspect candidates and owners.',
    };
  }

  function successBody() {
    return {
      kind: 'success_contract',
      summary: 'Six dimensions remain separate.',
      criteria: [
        {
          criterionId: 'necessary-escalation',
          label: 'Necessary escalation',
          utilityClaim: 'Ask only when a decision truly needs a human.',
          observationUnit: 'One project opportunity.',
          estimator: 'Verified necessary escalations divided by all independently found necessary opportunities.',
          counterexample: 'Only sampling emitted requests hides missed escalation opportunities.',
          gtDomain: 'semi_verifiable',
          judge: 'calibrated_judge',
          payer: { kind: 'mixed', detail: 'Engineering maintains capture; experts calibrate decisions.' },
          gtSourceKeys: ['domain-boundaries'],
          validityBounds: ['Only the reviewed project class and policy version.'],
          unknowns: ['The authorized judge is not yet named.'],
          nextAction: 'Calibrate boundary cases with an owner.',
        },
      ],
      unknowns: ['Thresholds are intentionally unset.'],
      nextAction: 'Connect GT sources before freezing a certificate.',
    };
  }

  async function createProgram(targetOwner = 'F311') {
    return programService.create({
      workspaceId: 'user:operator',
      targetRef: { ownerFeatureId: targetOwner, ownerStateRef: 'capability:pm-agent' },
      displayName: 'PM Agent 专业推进项目，只在必要时请人介入',
      clientMessageId: 'create-pm-program',
      actorRef: 'cat:codex-sol',
      originRef: `thread:${thread.id}:invocation:inv-create:message:create-pm-program`,
    });
  }

  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
    tick = 0;
    eventLog = new RedisEvolutionProgramEventLog(redis);
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    thread = await threadStore.create('operator', 'PM capability preparation', '/repo');
    invocationRecords = new Map();
    addInvocation();
    programService = new EvolutionProgramService({ eventLog });
    service = createService();
  });

  it('registers real work, stores one immutable F117 body, and reads the same revision after restart', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    const beforeObject = created.projection.program.objectRef;

    const working = await service.beginPreparationWork({
      programId,
      expectedSequence: 1,
      clientMessageId: 'begin-object-map',
      principal: principal(),
      section: 'object_map',
      itemId: 'prompt-policy',
      focus: 'Inspect the prompt, skill, subagent, model and environment candidates.',
      expectedCurrentSubmissionRef: null,
    });
    assert.equal(working.outcome, 'appended');
    assert.equal(working.projection.preparation.sections.object_map.activities[0].state, 'active');
    assert.equal(working.projection.preparation.sections.object_map.activities[0].catId, 'codex-sol');

    const submitted = await service.submitPreparation({
      programId,
      expectedSequence: 2,
      clientMessageId: 'submit-object-map',
      principal: principal(),
      section: 'object_map',
      title: '可进化对象',
      expectedCurrentSubmissionRef: null,
      dependsOn: [],
      body: objectMapBody(),
    });
    assert.equal(submitted.outcome, 'appended');
    assert.deepEqual(submitted.projection.program.objectRef, beforeObject);
    assert.equal(submitted.projection.program.stage, 'constituting');
    const current = submitted.projection.preparation.sections.object_map.current;
    assert.equal(current.status, 'submitted');
    assert.match(current.ref.version, /^sha256:[0-9a-f]{64}$/);
    assert.equal(current.submission.body.items[0].label, 'Prompt and policy');
    assert.equal(current.messageId.length > 0, true);
    assert.equal(messageStore.getRecent(10, 'operator').length, 1);
    assert.equal(
      messageStore.getById(current.messageId).extra.evolutionPreparationSubmissionV1.revision,
      current.ref.version,
    );

    const restarted = createService();
    const reread = await restarted.get(programId);
    assert.deepEqual(reread.preparation.sections.object_map.current, current);
    assert.equal(reread.preparation.sections.object_map.activities[0].state, 'superseded_by_submission');
  });

  it('keeps progress and modifiability independent and stops activity when the invocation terminates', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    await service.beginPreparationWork({
      programId,
      expectedSequence: 1,
      clientMessageId: 'begin-object-map',
      principal: principal(),
      section: 'object_map',
      itemId: 'prompt-policy',
      focus: 'Inspect the currently owned policy.',
      expectedCurrentSubmissionRef: null,
    });
    invocationRecords.get('inv-preparation').state = 'completed';
    const ended = await service.get(programId);
    assert.equal(ended.preparation.sections.object_map.activities[0].state, 'terminal');
    assert.equal(ended.preparation.sections.object_map.activities[0].spinning, false);

    invocationRecords.delete('inv-preparation');
    const unavailable = await service.get(programId);
    assert.equal(unavailable.preparation.sections.object_map.activities[0].state, 'unknown');
    assert.equal(unavailable.preparation.sections.object_map.activities[0].spinning, false);
  });

  it('rejects stale current and dependency revisions before creating an event or message', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    const first = await service.submitPreparation({
      programId,
      expectedSequence: 1,
      clientMessageId: 'submit-object-map-v1',
      principal: principal(),
      section: 'object_map',
      title: '可进化对象',
      expectedCurrentSubmissionRef: null,
      dependsOn: [],
      body: objectMapBody(),
    });
    const v1 = first.projection.preparation.sections.object_map.current.ref;
    const second = await service.submitPreparation({
      programId,
      expectedSequence: 2,
      clientMessageId: 'submit-object-map-v2',
      principal: principal(),
      section: 'object_map',
      title: '可进化对象',
      expectedCurrentSubmissionRef: v1,
      dependsOn: [],
      body: objectMapBody('Prompt, skill and model candidates'),
    });
    const v2 = second.projection.preparation.sections.object_map.current.ref;
    assert.notDeepEqual(v2, v1);

    const countBefore = (await eventLog.read(programId)).length;
    await assert.rejects(
      () =>
        service.submitPreparation({
          programId,
          expectedSequence: 3,
          clientMessageId: 'stale-object-map',
          principal: principal(),
          section: 'object_map',
          title: '可进化对象',
          expectedCurrentSubmissionRef: v1,
          dependsOn: [],
          body: objectMapBody('Stale overwrite'),
        }),
      (error) => error?.code === 'preparation_revision_conflict',
    );
    await assert.rejects(
      () =>
        service.submitPreparation({
          programId,
          expectedSequence: 3,
          clientMessageId: 'stale-success-dependency',
          principal: principal(),
          section: 'success_contract',
          title: '好坏规约',
          expectedCurrentSubmissionRef: null,
          dependsOn: [v1],
          body: successBody(),
        }),
      (error) => error?.code === 'preparation_dependency_conflict',
    );
    assert.equal((await eventLog.read(programId)).length, countBefore);
    assert.equal(messageStore.getRecent(20, 'operator').length, 2);
  });

  it('lets only one concurrent section CAS win and leaves no message for the loser', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    const submit = (suffix) =>
      service.submitPreparation({
        programId,
        expectedSequence: 1,
        clientMessageId: `concurrent-${suffix}`,
        principal: principal(),
        section: 'object_map',
        title: '可进化对象',
        expectedCurrentSubmissionRef: null,
        dependsOn: [],
        body: objectMapBody(`Candidate ${suffix}`),
      });
    const results = await Promise.all([submit('a'), submit('b')]);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['appended', 'conflict']);
    assert.equal(messageStore.getRecent(10, 'operator').length, 1);
    assert.equal((await eventLog.read(programId)).length, 2);
  });

  it('rejects a forged, terminal, deleted-thread, or cross-workspace invocation with zero side effects', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    const input = {
      programId,
      expectedSequence: 1,
      clientMessageId: 'forged-work',
      principal: principal(),
      section: 'object_map',
      focus: 'Pretend to work.',
      expectedCurrentSubmissionRef: null,
    };
    invocationRecords.get('inv-preparation').state = 'completed';
    await assert.rejects(
      () => service.beginPreparationWork(input),
      (error) => error?.code === 'preparation_actor_inactive',
    );
    invocationRecords.get('inv-preparation').state = 'active';
    await assert.rejects(
      () => service.beginPreparationWork({ ...input, principal: principal('inv-preparation', 'codex-terra') }),
      (error) => error?.code === 'preparation_actor_invalid',
    );
    thread.deletedAt = Date.now();
    await assert.rejects(
      () => service.beginPreparationWork(input),
      (error) => error?.code === 'preparation_source_unavailable',
    );
    thread.deletedAt = undefined;
    addInvocation('inv-other', 'codex-sol');
    await assert.rejects(
      () =>
        service.beginPreparationWork({
          ...input,
          clientMessageId: 'cross-workspace',
          principal: { ...principal('inv-other'), userId: 'other' },
        }),
      (error) => error?.code === 'program_not_found',
    );
    assert.equal((await eventLog.read(programId)).length, 1);
    assert.equal(messageStore.getRecent(10, 'operator').length, 0);
  });
});
