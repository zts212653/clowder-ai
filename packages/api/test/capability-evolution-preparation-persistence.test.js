import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = 'f311-preparation-persistence-test:';

function objectMapBody(label = 'Prompt, skills, subagents and model fit') {
  return {
    kind: 'object_map',
    goalStatement: '让 PM Agent 专业地推进项目，只在必要时请人介入',
    summary: 'The candidate map is an investigation aid, not multi-target write authority.',
    items: [
      {
        itemId: 'candidate-stack',
        label,
        scope: 'The current PM capability stack and its operating conditions.',
        why: 'Several layers can explain the observed outcome.',
        modifiability: { state: 'unknown', reason: 'Owner and version checks are incomplete.', basisRefs: [] },
        sourceRefs: [],
        nextAction: 'Resolve each owner and exact version.',
      },
    ],
    unknowns: ['No customer records or baseline are connected.'],
    nextAction: 'Inspect candidate owners before selecting an intervention.',
  };
}

describe('F311 preparation restart and source integrity', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let EvolutionProgramService;
  let EvolutionProgramPreparationService;
  let RedisEvolutionProgramEventLog;
  let RedisMessageStore;
  let RedisThreadStore;
  let InvocationRegistry;
  let RedisAuthInvocationBackend;
  let MessageKeys;
  let redis;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F311PreparationPersistence');
    ({ EvolutionProgramService } = await import('../dist/infrastructure/capability-evolution/program-service.js'));
    ({ EvolutionProgramPreparationService } = await import(
      '../dist/infrastructure/capability-evolution/program-preparation-service.js'
    ));
    ({ RedisEvolutionProgramEventLog } = await import(
      '../dist/infrastructure/capability-evolution/program-event-log.js'
    ));
    ({ RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'));
    ({ RedisThreadStore } = await import('../dist/domains/cats/services/stores/redis/RedisThreadStore.js'));
    ({ InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'));
    ({ RedisAuthInvocationBackend } = await import(
      '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js'
    ));
    ({ MessageKeys } = await import('../dist/domains/cats/services/stores/redis-keys/message-keys.js'));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
  });

  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  beforeEach(async () => cleanupClientKeyspace(redis));

  function registry() {
    return new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });
  }

  function preparation(eventLog, messageStore, threadStore, invocationReader, now) {
    const programService = new EvolutionProgramService({ eventLog });
    return new EvolutionProgramPreparationService({
      eventLog,
      projectProgram: (events) => programService.project(events),
      dependencies: { messageStore, threadStore, invocationReader },
      now,
    });
  }

  it('keeps Program, F117 body, thread and F167 activity at TTL=0 across restart and a new-cat revision', async () => {
    const eventLog = new RedisEvolutionProgramEventLog(redis);
    const firstMessages = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const firstThreads = new RedisThreadStore(redis, { ttlSeconds: 0 });
    const firstRegistry = registry();
    const thread = await firstThreads.create('operator', 'PM preparation persistence', '/repo');
    const solAuth = await firstRegistry.create('operator', 'codex-sol', thread.id);
    const sol = {
      kind: 'invocation',
      invocationId: solAuth.invocationId,
      userId: 'operator',
      catId: 'codex-sol',
      threadId: thread.id,
    };
    const program = await new EvolutionProgramService({ eventLog }).create({
      workspaceId: 'user:operator',
      targetRef: { ownerFeatureId: 'F311', ownerStateRef: 'capability:pm-agent' },
      clientMessageId: 'persistent-create',
      actorRef: 'cat:codex-sol',
      originRef: `thread:${thread.id}:invocation:${sol.invocationId}:message:persistent-create`,
    });
    const programId = program.projection.program.programId;
    const first = preparation(eventLog, firstMessages, firstThreads, firstRegistry, () => '2026-09-09T10:00:00.000Z');
    await first.beginPreparationWork({
      programId,
      expectedSequence: 1,
      clientMessageId: 'persistent-work',
      principal: sol,
      section: 'object_map',
      focus: 'Inspect owners and exact versions.',
      expectedCurrentSubmissionRef: null,
    });
    const submitted = await first.submitPreparation({
      programId,
      expectedSequence: 2,
      clientMessageId: 'persistent-submit',
      principal: sol,
      section: 'object_map',
      title: '可进化对象',
      expectedCurrentSubmissionRef: null,
      dependsOn: [],
      body: objectMapBody(),
    });
    const v1 = submitted.projection.preparation.sections.object_map.current;
    assert.equal(await eventLog.ttl(programId), -1);
    assert.equal(await redis.ttl(MessageKeys.detail(v1.messageId)), -1);

    const restartedMessages = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const restartedThreads = new RedisThreadStore(redis, { ttlSeconds: 0 });
    const restartedRegistry = registry();
    const restarted = preparation(
      new RedisEvolutionProgramEventLog(redis),
      restartedMessages,
      restartedThreads,
      restartedRegistry,
      () => '2026-09-09T10:01:00.000Z',
    );
    const recovered = await restarted.get(programId);
    assert.deepEqual(recovered.preparation.sections.object_map.current.submission, v1.submission);
    assert.equal(recovered.preparation.sections.object_map.activities[0].catId, 'codex-sol');

    await restartedRegistry.commitTerminal({
      invocationId: sol.invocationId,
      disposition: 'completed',
      endedAt: Date.parse('2026-09-09T10:01:30.000Z'),
      endReason: 'turn_complete',
    });
    const terraAuth = await restartedRegistry.create('operator', 'codex-terra', thread.id);
    const terra = { ...sol, invocationId: terraAuth.invocationId, catId: 'codex-terra' };
    await restarted.beginPreparationWork({
      programId,
      expectedSequence: 3,
      clientMessageId: 'terra-continues',
      principal: terra,
      section: 'object_map',
      focus: 'Continue from the exact prior revision.',
      expectedCurrentSubmissionRef: v1.ref,
    });
    const human = await restartedMessages.append({
      userId: 'operator',
      threadId: thread.id,
      catId: null,
      content: '本轮固定策略，先核清证据。',
      mentions: [],
      timestamp: 1,
    });
    const choiceBody = objectMapBody('陌生项目：持久策略 sentinel');
    choiceBody.items[0].category = 'Harness / 调度';
    choiceBody.items[0].decision = {
      state: 'fixed',
      reason: '按真实输入保持固定',
      responsibility: { kind: 'human', input: { threadId: thread.id, messageId: human.id } },
      basisRefs: [{ ownerFeatureId: 'F117', ownerStateRef: `message:${human.id}` }],
    };
    const revised = await restarted.submitPreparation({
      programId,
      expectedSequence: 4,
      clientMessageId: 'terra-submits',
      principal: terra,
      section: 'object_map',
      title: '可进化对象',
      expectedCurrentSubmissionRef: v1.ref,
      dependsOn: [],
      body: choiceBody,
    });
    assert.equal(revised.projection.preparation.sections.object_map.current.submission.authorCatId, 'codex-terra');
    assert.notEqual(revised.projection.preparation.sections.object_map.current.ref.version, v1.ref.version);
    assert.equal((await restartedMessages.getByThread(thread.id, 20, 'operator')).length, 3);
    const afterRestart = preparation(
      new RedisEvolutionProgramEventLog(redis),
      new RedisMessageStore(redis, { ttlSeconds: 0 }),
      new RedisThreadStore(redis, { ttlSeconds: 0 }),
      registry(),
    );
    const persisted = (await afterRestart.get(programId)).preparation.sections.object_map;
    assert.deepEqual(persisted.current.submission.body, choiceBody);
    assert.equal(persisted.current.inputSources[0].status, 'available');
    assert.deepEqual(persisted.history[0].submission, v1.submission);
  });

  it('fails closed when persisted source workspace, thread, author or digest no longer matches', async () => {
    const eventLog = new RedisEvolutionProgramEventLog(redis);
    const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const threads = new RedisThreadStore(redis, { ttlSeconds: 0 });
    const auth = registry();
    const thread = await threads.create('operator', 'Integrity', '/repo');
    const invocation = await auth.create('operator', 'codex-sol', thread.id);
    const principal = {
      kind: 'invocation',
      invocationId: invocation.invocationId,
      userId: 'operator',
      catId: 'codex-sol',
      threadId: thread.id,
    };
    const program = await new EvolutionProgramService({ eventLog }).create({
      workspaceId: 'user:operator',
      targetRef: { ownerFeatureId: 'F311', ownerStateRef: 'capability:pm-agent-integrity' },
      clientMessageId: 'integrity-create',
      actorRef: 'cat:codex-sol',
      originRef: `thread:${thread.id}:invocation:${principal.invocationId}:message:integrity-create`,
    });
    const service = preparation(eventLog, messages, threads, auth, () => '2026-09-09T11:00:00.000Z');
    const submitted = await service.submitPreparation({
      programId: program.projection.program.programId,
      expectedSequence: 1,
      clientMessageId: 'integrity-submit',
      principal,
      section: 'object_map',
      title: '可进化对象',
      expectedCurrentSubmissionRef: null,
      dependsOn: [],
      body: objectMapBody(),
    });
    const messageId = submitted.projection.preparation.sections.object_map.current.messageId;
    const detailKey = MessageKeys.detail(messageId);
    const mutations = [
      ['userId', 'other'],
      ['threadId', 'thread-other'],
      ['catId', 'codex-terra'],
    ];
    for (const [field, badValue] of mutations) {
      const original = await redis.hget(detailKey, field);
      await redis.hset(detailKey, field, badValue);
      assert.equal(
        (await service.get(program.projection.program.programId)).preparation.sections.object_map.current.status,
        'source_invalid',
      );
      await redis.hset(detailKey, field, original);
    }
    const rawExtra = await redis.hget(detailKey, 'extra');
    const parsedExtra = JSON.parse(rawExtra);
    parsedExtra.evolutionPreparationSubmissionV1.body.summary = 'tampered without a new revision';
    await redis.hset(detailKey, 'extra', JSON.stringify(parsedExtra));
    assert.equal(
      (await service.get(program.projection.program.programId)).preparation.sections.object_map.current.status,
      'source_invalid',
    );
  });
});
