import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { ActionSuccessorKeys } from '../dist/domains/ball-custody/action-successor-keys.js';
import { parseActionSuccessorLease } from '../dist/domains/ball-custody/action-successor-redis-codecs.js';
import { approvedTaskFixture, OWNER, TARGET, USER } from './helpers/approved-task-contract-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

async function seedLegacyCompletion(f, overrides = {}) {
  const subjectRef = overrides.subjectRef ?? 'subject:task:unrelated-task';
  const { lease } = await f.leases.claim({
    leaseId: 'historical-implementation',
    tenantScope: overrides.tenantScope ?? USER,
    subjectRef,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [TARGET],
    holderThreadId: 'unrelated-child',
    dispatchId: 'historical-dispatch',
    claimOrigin: 'structured_transfer',
    predecessorCatId: OWNER,
    predecessorThreadId: f.source.id,
    issuerStandingEvidenceRef: 'message:historical-source',
    evidenceRefs: ['message:historical-source'],
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef,
      predicate: { kind: 'task_done' },
    }),
    now: Date.now(),
  });
  const persisted = {
    ...lease,
    ...overrides,
    completionCandidates: { [TARGET]: { evidenceRefs: ['message:legacy-finished'], recordedAt: 1 } },
  };
  const raw = JSON.stringify(persisted);
  assert.throws(
    () => parseActionSuccessorLease(raw),
    /completion candidate requires machine-checkable completion evidence/,
  );
  const key = ActionSuccessorKeys.detail(lease.leaseId);
  await f.redis.set(key, raw);
  return { key, raw };
}

describe(
  'approved Task history does not validate unrelated completion payloads',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  () => {
    for (const legacy of [true, false]) {
      test(`${legacy ? 'legacy' : 'frozen'} approval continues and dispatches once despite a historical completion format`, async (t) => {
        const f = await approvedTaskFixture(t, { legacy });
        const historical = await seedLegacyCompletion(f);
        const response = await f.continueTask();
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().outcome, 'continued');
        const receipt = response.json().receipt;
        assert.equal((await f.implement()).statusCode, 200);
        assert.deepEqual((await f.continueTask()).json().receipt, receipt);
        assert.equal((await f.implement()).statusCode, 200);
        assert.equal((await f.queue.listAllDurable(f.childId)).length, 1);
        assert.equal(
          await f.redis.get(historical.key),
          historical.raw,
          'reading history never rewrites old completion evidence',
        );
      });
    }

    for (const sameTask of [false, true]) {
      test(`unrelated ${sameTask ? 'tenant' : 'Task'} provenance is not required to continue this approval`, async (t) => {
        const f = await approvedTaskFixture(t);
        const historical = await seedLegacyCompletion(f, {
          ...(sameTask ? { tenantScope: 'other-user', subjectRef: `subject:task:${f.task.id}` } : {}),
          evidenceRefs: { legacy: 'unreadable unrelated provenance' },
          returnTransitions: 'legacy-unrelated-shape',
        });
        const response = await f.continueTask();
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().outcome, 'continued');
        assert.equal(await f.redis.get(historical.key), historical.raw);
      });
    }

    const matches = {
      holder: (f) => ({ holderThreadId: f.childId }),
      evidence: (f) => ({ evidenceRefs: [`proposal:${f.proposalId}:approved`] }),
      returned: (f) => ({ returnTransitions: [{ rejectingThreadId: f.childId }] }),
      replacedFrom: (f) => ({
        replacementTransitions: [{ fromHolderThreadId: f.childId, toHolderThreadId: 'later-child' }],
      }),
      replacedTo: (f) => ({
        replacementTransitions: [{ fromHolderThreadId: 'earlier-child', toHolderThreadId: f.childId }],
      }),
    };
    for (const [via, fields] of Object.entries(matches)) {
      test(`matching implementation remains disqualifying via ${via} even when completion cannot be decoded`, async (t) => {
        const f = await approvedTaskFixture(t);
        await seedLegacyCompletion(f, { subjectRef: `subject:task:${f.task.id}`, ...fields(f) });
        const before = await f.redis.hgetall(`proposal:${f.proposalId}`);
        const response = await f.continueTask();
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().reason, 'already_implemented');
        assert.deepEqual(await f.redis.hgetall(`proposal:${f.proposalId}`), before);
        assert.equal((await f.queue.listAllDurable(f.childId)).length, 0);
      });
    }

    test('unreadable history identity still fails closed and cannot issue a receipt', async (t) => {
      const f = await approvedTaskFixture(t);
      const { key, raw } = await seedLegacyCompletion(f);
      const invalid = JSON.parse(raw);
      delete invalid.tenantScope;
      await f.redis.set(key, JSON.stringify(invalid));
      const response = await f.continueTask();
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().reason, 'unavailable');
      assert.equal(await f.redis.hget(`proposal:${f.proposalId}`, 'taskContractContinuation'), null);
    });
    test('history changing to a matching implementation at commit still invalidates the receipt CAS', async (t) => {
      const f = await approvedTaskFixture(t);
      const historical = await seedLegacyCompletion(f, { subjectRef: `subject:task:${f.task.id}` });
      const duplicate = f.redis.duplicate.bind(f.redis);
      let raced = false;
      f.redis.duplicate = (...args) => {
        const session = duplicate(...args);
        const multi = session.multi.bind(session);
        session.multi = (...multiArgs) => {
          const transaction = multi(...multiArgs);
          const exec = transaction.exec.bind(transaction);
          transaction.exec = async (...execArgs) => {
            if (!raced) {
              raced = true;
              await f.redis.set(
                historical.key,
                JSON.stringify({ ...JSON.parse(historical.raw), holderThreadId: f.childId }),
              );
            }
            return exec(...execArgs);
          };
          return transaction;
        };
        return session;
      };
      const response = await f.continueTask();
      assert.equal(raced, true);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().reason, 'concurrent_change');
      assert.equal(await f.redis.hget(`proposal:${f.proposalId}`, 'taskContractContinuation'), null);
      assert.equal((await f.continueTask()).json().reason, 'already_implemented');
    });
  },
);
