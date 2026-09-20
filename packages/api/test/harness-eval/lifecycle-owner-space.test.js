import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { loadEnrichedEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-summary-service.js';
import { ownerLifecycleSpace } from '../../dist/infrastructure/harness-eval/lifecycle-space.js';
import { deriveEvalCaseId } from '../../dist/infrastructure/harness-eval/publish-verdict/lifecycle-root-artifact.js';
import { createLocalArtifactPublisher } from '../../dist/infrastructure/harness-eval/publish-verdict/local-artifact-publisher.js';
import * as reevalClosureEventLog from '../../dist/infrastructure/harness-eval/reeval-closure-event-log.js';
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
 * F257 × F266 — a runtime artifact's lifecycle belongs to the owner who published it.
 *
 * Local artifacts carry immutable lifecycle roots, but the lifecycle loop read roots
 * only from the product repository, so an actionable runtime verdict could never be
 * opened, acknowledged, or re-evaluated. And because owner partitions let two owners
 * publish the same verdict or case id, one global event-log key per id would have let
 * their lifecycles overwrite each other the moment the roots were connected.
 *
 * The owners here are not the configured owner, whose space is the install's
 * (`lifecycle-install-space.test.js`): each has a space of its own runtime verdicts.
 */

const CONFIGURED_OWNER = 'install-owner';
const CASE_ID = deriveEvalCaseId('eval:harness-ledger', 'ledger-drift');

describe('owner lifecycle spaces', () => {
  let tmp;
  let harnessFeedbackRoot;
  let artifactStoreRoot;
  let installLog;
  let ownerLogs;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lifecycle-owner-space-'));
    harnessFeedbackRoot = join(tmp, 'repo', 'docs', 'harness-feedback');
    artifactStoreRoot = join(tmp, 'data', 'harness-feedback', 'artifacts');
    makeHarnessLedgerDomainRegistry(harnessFeedbackRoot);
    installLog = new MemoryLifecycleEventLog();
    ownerLogs = new Map([
      ['owner-a', new MemoryLifecycleEventLog()],
      ['owner-b', new MemoryLifecycleEventLog()],
    ]);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const ownerEventLog = (ownerUserId) => {
    const log = ownerLogs.get(ownerUserId);
    if (!log) throw new Error(`test has no event log for ${ownerUserId}`);
    return log;
  };

  async function publishActionable(owner, verdictId, root) {
    const packet = makePacket({ id: verdictId, verdict: 'fix' });
    const publisher = createLocalArtifactPublisher({ artifactRoot: artifactStoreRoot });
    return publisher.publishArtifact(
      publishOpts(
        packet,
        hubReadableGenerator(packet, { phenomenon: `${owner} sees ${verdictId}`, verdict: 'fix', lifecycleRoot: root }),
        owner,
      ),
    );
  }

  function caseRoot(verdictId) {
    return lifecycleRoot(verdictId, { schemaVersion: 2, caseId: CASE_ID, findingKey: 'ledger-drift' });
  }

  function summaryFor(userId) {
    return loadEnrichedEvalHubSummary({
      harnessFeedbackRoot,
      artifactStoreRoot,
      userId,
      configuredOwnerUserId: CONFIGURED_OWNER,
      lifecycleEventLog: installLog,
      ownerLifecycleEventLog: ownerEventLog,
      log: { warn() {} },
    });
  }

  async function openOwnerSubjects(ownerUserId, now = '2099-01-01T01:00:00.000Z') {
    const eventLog = ownerEventLog(ownerUserId);
    const subjects = await loadReevalClosureSubjects({
      space: ownerLifecycleSpace(harnessFeedbackRoot, { artifactStoreRoot, ownerUserId }),
      eventLog,
    });
    for (const subject of subjects) {
      for (const planned of planReevalClosureEvents(subject, now)) {
        const result = await eventLog.append(planned.event, planned.expectedSequence);
        assert.equal(result.outcome, 'appended', JSON.stringify(result));
      }
    }
    return subjects;
  }

  it('keys each owner’s lifecycle log apart and leaves the install keys where they were', () => {
    const { reevalClosureKeys } = reevalClosureEventLog;
    const install = reevalClosureKeys({ kind: 'install' });
    assert.equal(install.eventLog(CASE_ID), `eval:verdict-lifecycle:log:${CASE_ID}`);
    assert.equal(install.eventsSeen, 'eval:verdict-lifecycle:events:seen');
    assert.equal(install.verdicts, 'eval:verdict-lifecycle:verdicts');

    const ownerA = reevalClosureKeys({ kind: 'owner', ownerUserId: 'owner-a' });
    const ownerB = reevalClosureKeys({ kind: 'owner', ownerUserId: 'owner-b' });
    for (const [a, b, installKey] of [
      [ownerA.eventLog(CASE_ID), ownerB.eventLog(CASE_ID), install.eventLog(CASE_ID)],
      [ownerA.eventsSeen, ownerB.eventsSeen, install.eventsSeen],
      [ownerA.verdicts, ownerB.verdicts, install.verdicts],
    ]) {
      assert.notEqual(a, b);
      assert.notEqual(a, installKey);
      assert.equal(a.includes('owner-a'), false, 'the raw user id is not written into a key');
    }
  });

  it('opens a runtime verdict’s lifecycle from its owner’s artifact roots', async () => {
    await publishActionable('owner-a', 'hlr-actionable', lifecycleRoot('hlr-actionable'));

    const before = (await summaryFor('owner-a')).items.find((item) => item.id === 'hlr-actionable');
    assert.notEqual(before.lifecycle.unavailableReason, 'immutable lifecycle root unavailable');
    assert.equal(before.lifecycle.unavailableReason, 'canonical lifecycle record not initialized');

    const subjects = await openOwnerSubjects('owner-a');
    assert.deepEqual(
      subjects.map((subject) => subject.root.verdictId),
      ['hlr-actionable'],
    );
    const after = (await summaryFor('owner-a')).items.find((item) => item.id === 'hlr-actionable');
    assert.equal(after.lifecycle.availability, 'available', JSON.stringify(after.lifecycle));
    assert.deepEqual(await installLog.listSubjectIds(), [], 'another owner’s lifecycle never lands in the install log');
  });

  it('keeps two owners’ lifecycles of the same stable case apart', async () => {
    await publishActionable('owner-a', 'hlr-case-cycle', caseRoot('hlr-case-cycle'));
    await publishActionable('owner-b', 'hlr-case-cycle', caseRoot('hlr-case-cycle'));

    const subjects = await openOwnerSubjects('owner-a');
    assert.deepEqual(
      subjects.map((subject) => subject.caseRoot.caseId),
      [CASE_ID],
    );
    assert.ok((await ownerEventLog('owner-a').read(CASE_ID)).length > 0);
    assert.deepEqual(await ownerEventLog('owner-b').read(CASE_ID), []);

    const itemA = (await summaryFor('owner-a')).items.find((item) => item.id === 'hlr-case-cycle');
    assert.equal(itemA.lifecycle.availability, 'available', JSON.stringify(itemA.lifecycle));
    assert.equal(itemA.lifecycle.caseId, CASE_ID);

    const itemB = (await summaryFor('owner-b')).items.find((item) => item.id === 'hlr-case-cycle');
    assert.equal(itemB.lifecycle.unavailableReason, 'canonical lifecycle record not initialized');
  });

  describe('POST /api/eval-verdicts/:verdictId/lifecycle-events', () => {
    const invocations = {
      'invocation-a': { userId: 'owner-a', catId: 'codex' },
      'invocation-b': { userId: 'owner-b', catId: 'codex' },
    };

    async function buildApp(t) {
      const app = Fastify({ logger: false });
      const callbackRegistry = {
        async verify(invocationId, token) {
          const identity = invocations[invocationId];
          if (token !== 'valid-token' || !identity) return { ok: false, reason: 'invalid_token' };
          return {
            ok: true,
            record: {
              invocationId,
              callbackToken: 'valid-token',
              ...identity,
              threadId: 'thread_eval_harness_ledger',
              clientMessageIds: new Set(),
              createdAt: Date.now() - 1_000,
              expiresAt: Date.now() + 60_000,
            },
          };
        },
      };
      await app.register(evalVerdictLifecycleRoutes, {
        harnessFeedbackRoot,
        configuredOwnerUserId: CONFIGURED_OWNER,
        eventLog: installLog,
        artifactStoreRoot,
        ownerEventLog,
        callbackRegistry,
        releaseTruth: {
          verifyMainLanded: () => assert.fail('no release claim in these commands'),
          verifyLiveActive: () => assert.fail('no release claim in these commands'),
        },
        now: () => '2099-01-01T02:00:00.000Z',
      });
      t.after(() => app.close());
      return app;
    }

    function send(app, verdictId, invocationId, type, expectedSequence) {
      return app.inject({
        method: 'POST',
        url: `/api/eval-verdicts/${verdictId}/lifecycle-events`,
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': 'valid-token' },
        payload: {
          type,
          eventId: `${type}-${invocationId}`,
          expectedSequence,
          reason: `${type} with durable evidence`,
          refs: [{ kind: 'message', availability: 'available', value: `thread:${invocationId}` }],
        },
      });
    }

    const acknowledge = (app, verdictId, invocationId) => send(app, verdictId, invocationId, 'acknowledge', 0);

    async function seedBoundCase(ownerUserId, verdictId) {
      const base = { caseId: CASE_ID, verdictId, domainId: 'eval:harness-ledger' };
      const actor = { kind: 'automation', id: 'eval-verdict-closure-reconciler' };
      const log = ownerEventLog(ownerUserId);
      await log.append(
        {
          ...base,
          eventId: `${ownerUserId}-observe`,
          type: 'verdict_cycle_observed',
          actor,
          occurredAt: '2099-01-01T00:01:00.000Z',
          cycleCreatedAt: '2099-01-01T00:00:00.000Z',
          reason: 'cycle observed',
          refs: [{ kind: 'verdict', availability: 'available', value: `verdict:${verdictId}` }],
        },
        0,
      );
      await log.append(
        {
          ...base,
          eventId: `${ownerUserId}-bound`,
          type: 'responsibility_bound',
          actor,
          occurredAt: '2099-01-01T00:02:00.000Z',
          reason: 'responsibility bound',
          refs: [{ kind: 'task', availability: 'available', value: `task:${ownerUserId}` }],
          taskId: `task-${ownerUserId}`,
          leaseId: `lease-${ownerUserId}`,
          leaseGeneration: 1,
        },
        1,
      );
    }

    it('writes a command into the calling owner’s lifecycle only', async (t) => {
      await publishActionable('owner-a', 'hlr-shared', lifecycleRoot('hlr-shared'));
      await publishActionable('owner-b', 'hlr-shared', lifecycleRoot('hlr-shared'));
      const app = await buildApp(t);

      const byA = await acknowledge(app, 'hlr-shared', 'invocation-a');
      assert.equal(byA.statusCode, 200, byA.body);
      const typesA = (await ownerEventLog('owner-a').read('hlr-shared')).map((event) => event.type);
      assert.deepEqual(typesA, ['verdict_opened', 'owner_acknowledged']);
      assert.deepEqual(await ownerEventLog('owner-b').read('hlr-shared'), []);
      assert.deepEqual(await installLog.read('hlr-shared'), []);

      const byB = await acknowledge(app, 'hlr-shared', 'invocation-b');
      assert.equal(byB.statusCode, 200, byB.body);
      assert.equal((await ownerEventLog('owner-b').read('hlr-shared')).length, 2);
      assert.equal((await ownerEventLog('owner-a').read('hlr-shared')).length, 2, 'owner-b did not touch owner-a');
    });

    it('writes a stable-case command into the calling owner’s case only', async (t) => {
      await publishActionable('owner-a', 'hlr-case-cycle', caseRoot('hlr-case-cycle'));
      await publishActionable('owner-b', 'hlr-case-cycle', caseRoot('hlr-case-cycle'));
      await seedBoundCase('owner-a', 'hlr-case-cycle');
      await seedBoundCase('owner-b', 'hlr-case-cycle');
      const app = await buildApp(t);

      const byA = await send(app, 'hlr-case-cycle', 'invocation-a', 'plan_action', 2);
      assert.equal(byA.statusCode, 200, byA.body);
      assert.equal((await ownerEventLog('owner-a').read(CASE_ID)).at(-1).type, 'action_planned');
      assert.equal((await ownerEventLog('owner-b').read(CASE_ID)).length, 2, 'owner-a did not touch owner-b');

      const byB = await send(app, 'hlr-case-cycle', 'invocation-b', 'plan_action', 2);
      assert.equal(byB.statusCode, 200, byB.body);
      assert.equal((await ownerEventLog('owner-a').read(CASE_ID)).length, 3);
      assert.deepEqual(await installLog.listSubjectIds(), []);
    });

    it('does not let one owner command another owner’s verdict', async (t) => {
      await publishActionable('owner-a', 'hlr-a-only', lifecycleRoot('hlr-a-only'));
      const app = await buildApp(t);

      const byB = await acknowledge(app, 'hlr-a-only', 'invocation-b');
      assert.equal(byB.statusCode, 404, byB.body);
      assert.deepEqual(await ownerEventLog('owner-a').read('hlr-a-only'), []);
      assert.deepEqual(await ownerEventLog('owner-b').read('hlr-a-only'), []);
    });
  });
});
