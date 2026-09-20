import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { loadEnrichedEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-summary-service.js';
import * as lifecycleSpaces from '../../dist/infrastructure/harness-eval/lifecycle-space.js';
import { deriveEvalCaseId } from '../../dist/infrastructure/harness-eval/publish-verdict/lifecycle-root-artifact.js';
import { createLocalArtifactPublisher } from '../../dist/infrastructure/harness-eval/publish-verdict/local-artifact-publisher.js';
import { planReevalClosureEvents } from '../../dist/infrastructure/harness-eval/reeval-closure-reconciler.js';
import { loadReevalClosureSubjects } from '../../dist/infrastructure/harness-eval/reeval-closure-task-spec.js';
import { evalVerdictLifecycleRoutes } from '../../dist/routes/eval-verdict-lifecycle.js';
import {
  hubReadableGenerator,
  lifecycleRoot,
  makeHarnessLedgerDomainRegistry,
  makePacket,
  publishOpts,
} from './local-artifact-publisher-fixtures.js';
import { MemoryLifecycleEventLog } from './memory-lifecycle-event-log.js';

/**
 * F257 × F266 — a stable case keeps one identity whichever store holds its cycles.
 *
 * A case id is derived from domain + finding so that a finding's lifecycle carries
 * across evaluation cycles. After verdicts became runtime artifacts, the configured
 * owner's next cycle of a case whose earlier cycles were committed to the repository
 * was projected, logged and reconciled in a space of its own: the Eval Hub showed the
 * case twice, and its history, responsibility and events split into two chains.
 */

const CONFIGURED_OWNER = 'install-owner';
const CASE_ID = deriveEvalCaseId('eval:harness-ledger', 'ledger-drift');
const REPO_CYCLE_AT = '2099-01-01T00:00:00.000Z';
const ARTIFACT_CYCLE_AT = '2099-01-02T00:00:00.000Z';
const CASE_CYCLE_IDS = ['repo-cycle', 'artifact-cycle', 'owner-b-cycle'];

const caseRoot = (verdictId, createdAt) =>
  lifecycleRoot(verdictId, { schemaVersion: 2, caseId: CASE_ID, findingKey: 'ledger-drift', createdAt });

function caseEvent(verdictId, type, occurredAt, extra = {}) {
  return {
    eventId: `${type}-${verdictId}`,
    caseId: CASE_ID,
    verdictId,
    domainId: 'eval:harness-ledger',
    type,
    actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
    occurredAt,
    reason: `${type} for ${verdictId}`,
    refs: [{ kind: 'other', availability: 'available', value: `${type}:${verdictId}` }],
    ...extra,
  };
}

const invocations = {
  'invocation-configured': { userId: CONFIGURED_OWNER, catId: 'codex' },
  'invocation-b': { userId: 'owner-b', catId: 'codex' },
};

const callbackRegistry = {
  async verify(invocationId, token) {
    const identity = invocations[invocationId];
    if (token !== 'valid-token' || !identity) return { ok: false, reason: 'invalid_token' };
    const now = Date.now();
    const record = { invocationId, callbackToken: token, ...identity, threadId: 'thread_eval_harness_ledger' };
    return {
      ok: true,
      record: { ...record, clientMessageIds: new Set(), createdAt: now - 1_000, expiresAt: now + 60_000 },
    };
  },
};

describe('the configured owner’s lifecycle space', () => {
  let tmp;
  let harnessFeedbackRoot;
  let artifactStoreRoot;
  let installLog;
  let ownerLogs;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lifecycle-install-space-'));
    harnessFeedbackRoot = join(tmp, 'repo', 'docs', 'harness-feedback');
    artifactStoreRoot = join(tmp, 'data', 'harness-feedback', 'artifacts');
    makeHarnessLedgerDomainRegistry(harnessFeedbackRoot);
    installLog = new MemoryLifecycleEventLog();
    ownerLogs = new Map();

    // An earlier cycle, committed to the repository before verdicts became runtime artifacts,
    // with the history the install recorded for it.
    const repoPacket = makePacket({ id: 'repo-cycle', verdict: 'fix' });
    const repoRoot = caseRoot('repo-cycle', REPO_CYCLE_AT);
    await hubReadableGenerator(repoPacket, { verdict: 'fix', lifecycleRoot: repoRoot })(harnessFeedbackRoot);
    const observed = caseEvent('repo-cycle', 'verdict_cycle_observed', '2099-01-01T01:00:00.000Z', {
      cycleCreatedAt: REPO_CYCLE_AT,
    });
    await installLog.append(observed, 0);
    const suppressed = caseEvent('repo-cycle', 'cvo_suppressed', '2099-01-01T02:00:00.000Z', {
      actor: { kind: 'cvo', id: CONFIGURED_OWNER },
    });
    await installLog.append(suppressed, 1);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function ownerLog(ownerUserId) {
    if (!ownerLogs.has(ownerUserId)) ownerLogs.set(ownerUserId, new MemoryLifecycleEventLog());
    return ownerLogs.get(ownerUserId);
  }

  async function publishCycle(owner, verdictId, createdAt) {
    const packet = makePacket({ id: verdictId, verdict: 'fix' });
    const generate = hubReadableGenerator(packet, { verdict: 'fix', lifecycleRoot: caseRoot(verdictId, createdAt) });
    await createLocalArtifactPublisher({ artifactRoot: artifactStoreRoot }).publishArtifact(
      publishOpts(packet, generate, owner),
    );
  }

  const summaryFor = (userId) =>
    loadEnrichedEvalHubSummary({
      harnessFeedbackRoot,
      artifactStoreRoot,
      userId,
      configuredOwnerUserId: CONFIGURED_OWNER,
      lifecycleEventLog: installLog,
      ownerLifecycleEventLog: ownerLog,
      log: { warn() {} },
    });

  const caseCards = (summary) => summary.items.filter((item) => CASE_CYCLE_IDS.includes(item.id));

  async function buildApp(t) {
    const app = Fastify({ logger: false });
    await app.register(evalVerdictLifecycleRoutes, {
      harnessFeedbackRoot,
      configuredOwnerUserId: CONFIGURED_OWNER,
      eventLog: installLog,
      artifactStoreRoot,
      ownerEventLog: ownerLog,
      callbackRegistry,
      releaseTruth: {
        verifyMainLanded: () => assert.fail('no release claim in these commands'),
        verifyLiveActive: () => assert.fail('no release claim in these commands'),
      },
      now: () => '2099-01-02T03:00:00.000Z',
    });
    t.after(() => app.close());
    return app;
  }

  function planAction(app, verdictId, invocationId, expectedSequence) {
    return app.inject({
      method: 'POST',
      url: `/api/eval-verdicts/${verdictId}/lifecycle-events`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': 'valid-token' },
      payload: {
        type: 'plan_action',
        eventId: `plan-${verdictId}-${invocationId}`,
        expectedSequence,
        reason: 'plan the repair with durable evidence',
        refs: [{ kind: 'message', availability: 'available', value: `thread:${invocationId}` }],
      },
    });
  }

  it('shows the case once when its next cycle is the configured owner’s runtime artifact', async () => {
    await publishCycle(CONFIGURED_OWNER, 'artifact-cycle', ARTIFACT_CYCLE_AT);

    const cards = caseCards(await summaryFor(CONFIGURED_OWNER));
    const shown = cards.map((card) => ({ id: card.id, source: card.source.kind, lifecycle: card.lifecycle }));
    assert.equal(cards.length, 1, JSON.stringify(shown));
    assert.equal(cards[0].id, 'artifact-cycle');
    assert.equal(cards[0].lifecycle.availability, 'available', JSON.stringify(cards[0].lifecycle));
    assert.equal(cards[0].lifecycle.caseId, CASE_ID);
    assert.deepEqual(cards[0].lifecycle.observedVerdictIds, ['repo-cycle'], 'the repository history carries over');
  });

  it('reconciles the configured owner’s artifact cycle into the case’s one chain', async () => {
    await publishCycle(CONFIGURED_OWNER, 'artifact-cycle', ARTIFACT_CYCLE_AT);
    const space = lifecycleSpaces.installLifecycleSpace(harnessFeedbackRoot, {
      artifactStoreRoot,
      ownerUserId: CONFIGURED_OWNER,
    });

    const subjects = await loadReevalClosureSubjects({ space, eventLog: installLog });
    assert.equal(subjects.length, 1);
    assert.deepEqual(
      subjects[0].caseRoot.cycles.map((cycle) => cycle.verdictId),
      ['repo-cycle', 'artifact-cycle'],
    );
    const planned = planReevalClosureEvents(subjects[0], '2099-01-02T01:00:00.000Z');
    assert.deepEqual(
      [planned[0].event.type, planned[0].event.verdictId, planned[0].expectedSequence],
      ['verdict_cycle_observed', 'artifact-cycle', 2],
    );
    for (const { event, expectedSequence } of planned) {
      assert.equal((await installLog.append(event, expectedSequence)).outcome, 'appended');
    }
    assert.deepEqual([...ownerLogs.keys()], [], 'no second chain was opened');
  });

  it('writes the configured owner’s command on its artifact cycle into the case’s one chain', async (t) => {
    await publishCycle(CONFIGURED_OWNER, 'artifact-cycle', ARTIFACT_CYCLE_AT);
    const observed = caseEvent('artifact-cycle', 'verdict_cycle_observed', '2099-01-02T01:00:00.000Z', {
      cycleCreatedAt: ARTIFACT_CYCLE_AT,
    });
    await installLog.append(observed, 2);
    const bound = caseEvent('artifact-cycle', 'responsibility_bound', '2099-01-02T02:00:00.000Z', {
      taskId: 'task-artifact-cycle',
      leaseId: 'lease-artifact-cycle',
      leaseGeneration: 1,
    });
    await installLog.append(bound, 3);
    const app = await buildApp(t);

    const response = await planAction(app, 'artifact-cycle', 'invocation-configured', 4);
    assert.equal(response.statusCode, 200, response.body);
    const chain = await installLog.read(CASE_ID);
    assert.equal(chain.length, 5);
    assert.deepEqual([chain[4].type, chain[4].verdictId], ['action_planned', 'artifact-cycle']);
    assert.deepEqual([...ownerLogs.keys()], [], 'no second chain was opened');
  });

  it('leaves another owner its own cycle of the case, and none of the configured owner’s', async (t) => {
    await publishCycle(CONFIGURED_OWNER, 'artifact-cycle', ARTIFACT_CYCLE_AT);
    await publishCycle('owner-b', 'owner-b-cycle', ARTIFACT_CYCLE_AT);

    const cards = new Map(caseCards(await summaryFor('owner-b')).map((card) => [card.id, card]));
    assert.deepEqual([...cards.keys()].sort(), ['owner-b-cycle', 'repo-cycle']);
    assert.equal(cards.get('owner-b-cycle').lifecycle.unavailableReason, 'canonical lifecycle record not initialized');
    assert.equal(cards.get('repo-cycle').lifecycle.availability, 'unavailable');
    assert.equal(
      cards.get('repo-cycle').lifecycle.unavailableReason,
      'verdict lifecycle belongs to another lifecycle space',
    );

    const app = await buildApp(t);
    const onRepositoryCycle = await planAction(app, 'repo-cycle', 'invocation-b', 2);
    assert.equal(onRepositoryCycle.statusCode, 404, onRepositoryCycle.body);
    assert.equal((await installLog.read(CASE_ID)).length, 2, 'another owner cannot write the configured owner’s case');
  });

  it('refuses a space in which a repository verdict and a runtime artifact share an id', async () => {
    await publishCycle(CONFIGURED_OWNER, 'artifact-cycle', ARTIFACT_CYCLE_AT);
    // An edit outside the publisher commits a verdict under an id the configured owner already published.
    const duplicate = makePacket({ id: 'artifact-cycle', verdict: 'fix' });
    const duplicateRoot = caseRoot('artifact-cycle', ARTIFACT_CYCLE_AT);
    await hubReadableGenerator(duplicate, { verdict: 'fix', lifecycleRoot: duplicateRoot })(harnessFeedbackRoot);
    const space = lifecycleSpaces.installLifecycleSpace(harnessFeedbackRoot, {
      artifactStoreRoot,
      ownerUserId: CONFIGURED_OWNER,
    });

    assert.throws(
      () => lifecycleSpaces.loadLifecycleSpaceRoots(space),
      /^Error: lifecycle_root_conflict: verdict 'artifact-cycle' has a root in the repository and in the runtime artifact store/,
    );
  });
});
