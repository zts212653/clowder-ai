import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = 'f266-verdict-closure-e2e:';

const availableRef = (kind, value) => ({ kind, availability: 'available', value });

function lifecycleArtifact(verdictId, overrides = {}) {
  return {
    schemaVersion: 1,
    verdictId,
    domainId: 'eval:capability-tips',
    createdAt: '2026-07-18T00:00:00.000Z',
    verdict: 'fix',
    harnessUnderEval: { featureId: 'F268', componentId: 'tips', name: 'capability-tips' },
    ownerAsk: {
      targetFeatureId: 'F268',
      targetOwnerCatId: 'codex-sol',
      requestedAction: 'repair the actionable harness finding',
    },
    acceptanceReevalPlan: {
      nextEvalAt: '2026-07-25T00:00:00.000Z',
      closureCondition: 'the assigned evaluator verifies the repaired behavior',
    },
    ...overrides,
  };
}

function projectorRoot(artifact) {
  return {
    verdictId: artifact.verdictId,
    domainId: artifact.domainId,
    targetOwnerCatId: artifact.ownerAsk.targetOwnerCatId,
    assignedEvalCatId: 'gpt52',
    reevalWithinHours: 168,
  };
}

function opened(root) {
  return {
    eventId: `f266:${root.verdictId}:opened`,
    verdictId: root.verdictId,
    domainId: root.domainId,
    type: 'verdict_opened',
    actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
    occurredAt: '2026-07-18T00:00:00.000Z',
    reason: 'actionable verdict published with immutable lifecycle root metadata',
    refs: [availableRef('verdict', `docs/harness-feedback/verdicts/${root.verdictId}.md`)],
  };
}

function command(verdictId, type, expectedSequence, overrides = {}) {
  return {
    type,
    eventId: `${verdictId}:${type}:${expectedSequence}`,
    verdictId,
    expectedSequence,
    reason: `${type} is backed by explicit lifecycle evidence`,
    refs: [availableRef('message', `thread:${verdictId}:${type}`)],
    ...overrides,
  };
}

describe('F266 eval verdict closure journeys (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let ReevalClosureKeys;
  let RedisReevalClosureEventLog;
  let ReevalClosureService;
  let planReevalClosureEvents;
  let projectReevalClosure;
  let createRedisClient;
  let redis;
  let eventLog;
  let roots;
  let clockSequence;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F266EvalVerdictClosureE2E');
    ({ ReevalClosureKeys, RedisReevalClosureEventLog } = await import(
      '../../dist/infrastructure/harness-eval/reeval-closure-event-log.js'
    ));
    ({ ReevalClosureService } = await import('../../dist/infrastructure/harness-eval/reeval-closure-service.js'));
    ({ planReevalClosureEvents } = await import('../../dist/infrastructure/harness-eval/reeval-closure-reconciler.js'));
    ({ projectReevalClosure } = await import('../../dist/infrastructure/harness-eval/reeval-closure.js'));
    ({ createRedisClient } = await import('@cat-cafe/shared/utils'));

    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
    eventLog = new RedisReevalClosureEventLog(redis);
  });

  after(async () => {
    if (redis) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
    roots = new Map();
    clockSequence = 0;
  });

  function serviceFor(log = eventLog) {
    return new ReevalClosureService({
      eventLog: log,
      loadRoot: async (verdictId) => roots.get(verdictId),
      loadBootstrap: async (verdictId) => {
        const loadedRoot = roots.get(verdictId);
        return loadedRoot ? [opened(loadedRoot)] : undefined;
      },
      now: () => {
        clockSequence += 1;
        return new Date(Date.parse('2026-07-18T01:00:00.000Z') + clockSequence * 1_000).toISOString();
      },
    });
  }

  async function replayThroughNewProcess(root, expectedProjection) {
    const restartedRedis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    try {
      await restartedRedis.ping();
      const restartedLog = new RedisReevalClosureEventLog(restartedRedis);
      const restartedEvents = await restartedLog.read(root.verdictId);
      assert.deepEqual(projectReevalClosure(root, restartedEvents), expectedProjection);
      return restartedLog;
    } finally {
      await restartedRedis.quit();
    }
  }

  it('requires verified re-evaluation after a recorded fix and replays resolved truth after restart', async () => {
    const artifact = lifecycleArtifact('f266-e2e-fix');
    const root = projectorRoot(artifact);
    roots.set(root.verdictId, root);
    await eventLog.append(opened(root), 0);
    const service = serviceFor();

    await service.execute({ kind: 'cat', id: 'codex-sol' }, command(root.verdictId, 'acknowledge', 1));
    await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command(root.verdictId, 'plan_action', 2, { refs: [availableRef('plan', 'task:f266-e2e-fix')] }),
    );
    const fixed = await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command(root.verdictId, 'record_fix', 3, { refs: [availableRef('commit', '50ec90163')] }),
    );
    assert.equal(fixed.projection.status, 'fix_landed', 'a fix ref alone must not resolve the verdict');

    await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command(root.verdictId, 'request_reeval', 4, {
        refs: [availableRef('reeval', 'eval:capability-tips:2026-07-19')],
      }),
    );
    const resolved = await service.execute(
      { kind: 'cat', id: 'gpt52' },
      command(root.verdictId, 'record_reeval_result', 5, {
        result: 'passed',
        refs: [availableRef('reeval', 'docs/harness-feedback/verdicts/f266-e2e-fix-reeval.md')],
      }),
    );

    assert.equal(resolved.projection.status, 'resolved');
    assert.equal(resolved.projection.actionRefs[0]?.value, '50ec90163');
    assert.equal(resolved.projection.reevalRefs.length, 2);
    await replayThroughNewProcess(root, resolved.projection);
    assert.equal(await redis.ttl(ReevalClosureKeys.eventLog(root.verdictId)), -1);
  });

  it('accepts reasoned suppression only from operator authority and replays its evidence after restart', async () => {
    const artifact = lifecycleArtifact('f266-e2e-suppression');
    const root = projectorRoot(artifact);
    roots.set(root.verdictId, root);
    await eventLog.append(opened(root), 0);
    const service = serviceFor();
    const suppression = command(root.verdictId, 'suppress', 1, {
      reason: 'operator accepts the measured tradeoff for this actionable verdict',
      refs: [availableRef('message', 'thread:cvo-suppression-decision')],
    });

    await assert.rejects(service.execute({ kind: 'cat', id: 'codex-sol' }, suppression));
    assert.equal((await eventLog.read(root.verdictId)).length, 1);

    const suppressed = await service.execute({ kind: 'cvo', id: 'you' }, suppression);
    assert.equal(suppressed.projection.status, 'suppressed_with_reason');
    assert.equal(suppressed.projection.closureReason, suppression.reason);
    assert.deepEqual(suppressed.projection.history.at(-1).actor, { kind: 'cvo', id: 'you' });
    assert.deepEqual(suppressed.projection.history.at(-1).refs, suppression.refs);
    await replayThroughNewProcess(root, suppressed.projection);
  });

  it('deduplicates SLA escalation and gives automation no fix, merge, or suppress capability', async () => {
    const artifact = lifecycleArtifact('f266-e2e-escalation');
    const root = projectorRoot(artifact);
    roots.set(root.verdictId, root);
    const subject = {
      root: artifact,
      assignedEvalCatId: root.assignedEvalCatId,
      acknowledgeHours: 24,
      events: [],
      openRefs: [availableRef('verdict', 'docs/harness-feedback/verdicts/f266-e2e-escalation.md')],
    };
    const firstTick = planReevalClosureEvents(subject, '2026-07-20T00:00:00.000Z');
    const retryTick = planReevalClosureEvents(subject, '2026-07-21T00:00:00.000Z');
    assert.deepEqual(
      firstTick.map((item) => item.event.eventId),
      retryTick.map((item) => item.event.eventId),
    );
    for (const planned of firstTick) await eventLog.append(planned.event, planned.expectedSequence);

    const escalatedEvents = await eventLog.read(root.verdictId);
    const escalated = projectReevalClosure(root, escalatedEvents);
    assert.equal(escalated.status, 'escalated');
    assert.equal(escalated.escalation?.stage, 'acknowledgement');
    assert.deepEqual(planReevalClosureEvents({ ...subject, events: escalatedEvents }, '2026-07-22T00:00:00.000Z'), []);
    await replayThroughNewProcess(root, escalated);

    const service = serviceFor();
    await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command(root.verdictId, 'acknowledge', 2, { eventId: `${root.verdictId}:acknowledged` }),
    );
    await service.execute(
      { kind: 'cat', id: 'codex-sol' },
      command(root.verdictId, 'plan_action', 3, { eventId: `${root.verdictId}:planned` }),
    );
    const eventCountBeforeForbiddenCommands = (await eventLog.read(root.verdictId)).length;

    for (const forbidden of [
      command(root.verdictId, 'record_fix', 4),
      command(root.verdictId, 'merge_fix', 4),
      command(root.verdictId, 'suppress', 4),
    ]) {
      await assert.rejects(service.execute({ kind: 'automation', id: 'eval-verdict-closure-reconciler' }, forbidden));
    }
    assert.equal((await eventLog.read(root.verdictId)).length, eventCountBeforeForbiddenCommands);
  });
});
