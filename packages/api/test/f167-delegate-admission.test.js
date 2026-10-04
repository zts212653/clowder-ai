/**
 * F167 × F322 — Suite 2: Full resolver→admission path tests with
 * server-resolved delegates. Covers positive admission, P1-2 evidence
 * propagation, and four negative cases from F322 consumption boundary.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  APPROVED_DELEGATE,
  admissionRequest,
  makeTask,
  mockLeaseStore,
  OWNER_CAT,
  OWNER_THREAD,
  TASK_ID,
  TENANT,
} from './f167-delegate-test-helpers.js';

const { ActionSuccessorAdmissionService, ActionSuccessorStandingError } = await import(
  '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'
);
const { ActionSubjectTruthResolver } = await import('../dist/domains/ball-custody/ActionSubjectTruthResolver.js');

/** Build a resolver with configurable delegate and task providers. */
function buildResolver({ task = makeTask(), delegates = [] } = {}) {
  const leaseStore = {
    async getSubjectTerminal() {
      return null;
    },
    async markSubjectTerminal(input) {
      return { subjectRef: input.subjectRef, state: input.state, observedAt: input.now };
    },
    async clearSubjectTerminal() {},
  };
  const communityStore = {
    async get() {
      return null;
    },
  };
  const taskProvider = {
    async get(id) {
      return id === task.id ? task : null;
    },
  };
  const delegateProvider = {
    async getForTask(reqTaskId, taskThreadId, currentOwnerCatId, tenantScope) {
      if (
        reqTaskId === TASK_ID &&
        taskThreadId === OWNER_THREAD &&
        currentOwnerCatId === OWNER_CAT &&
        tenantScope === TENANT
      ) {
        return delegates;
      }
      return [];
    },
  };
  return new ActionSubjectTruthResolver(
    leaseStore,
    communityStore,
    undefined,
    taskProvider,
    undefined,
    delegateProvider,
  );
}

/** Build an admission service with the given resolver and a mock lease store. */
function buildAdmission(resolver) {
  const leaseStore = mockLeaseStore();
  return { service: new ActionSuccessorAdmissionService(leaseStore, resolver), leaseStore };
}

describe('F167 approved-child delegation — resolver→admission path', () => {
  // ── Positive: server-resolved delegate passes admission ──

  test('approved child admitted when delegate provider returns valid binding', async () => {
    const resolver = buildResolver({ delegates: [APPROVED_DELEGATE] });
    const { service } = buildAdmission(resolver);
    const result = await service.admit(admissionRequest());
    assert.equal(result.admit, true, 'approved child should be admitted');
    assert.equal(result.outcome, 'claimed');
  });

  // ── P1-2: delegate authority evidence must be written into the lease ──

  test('delegate proposal evidenceRef is included in the lease evidenceRefs', async () => {
    const resolver = buildResolver({ delegates: [APPROVED_DELEGATE] });
    const { service, leaseStore } = buildAdmission(resolver);
    const result = await service.admit(admissionRequest());
    assert.equal(result.admit, true);

    const evidenceRefs = leaseStore.claimedLease.evidenceRefs;
    assert.ok(
      evidenceRefs.some((ref) => ref.startsWith('proposal:') && ref.includes(':approved:')),
      `lease evidenceRefs must include proposal authority ref, got: ${JSON.stringify(evidenceRefs)}`,
    );
    assert.ok(
      evidenceRefs.includes(APPROVED_DELEGATE.evidenceRef),
      `lease must include exact delegate evidenceRef '${APPROVED_DELEGATE.evidenceRef}', got: ${JSON.stringify(evidenceRefs)}`,
    );
  });

  test('canonical owner lease does NOT include delegate evidenceRef', async () => {
    const resolver = buildResolver({ delegates: [] });
    const { service, leaseStore } = buildAdmission(resolver);
    const result = await service.admit(
      admissionRequest({
        actorCatId: OWNER_CAT,
        sourceThreadId: OWNER_THREAD,
        targetThreadId: OWNER_THREAD,
        holderCatIds: [OWNER_CAT],
      }),
    );
    assert.equal(result.admit, true);

    const evidenceRefs = leaseStore.claimedLease.evidenceRefs;
    assert.equal(evidenceRefs.length, 2, 'canonical owner should have exactly 2 evidenceRefs');
    assert.ok(
      !evidenceRefs.some((ref) => ref.startsWith('proposal:')),
      'canonical owner lease should NOT contain proposal evidence',
    );
  });

  // ── Negative 1: different task borrowing the same approved child ──

  test('different task with no delegates rejects the child', async () => {
    const resolver = buildResolver({
      task: makeTask({ threadId: 'thread-different-task' }),
      delegates: [APPROVED_DELEGATE],
    });
    const { service } = buildAdmission(resolver);
    await assert.rejects(
      service.admit(admissionRequest()),
      (err) => err instanceof ActionSuccessorStandingError && err.mismatchDimensions.includes('owner'),
      "different task should not borrow another task's approved child",
    );
  });

  // ── Negative 1b: same thread, different task (P1-1) ──

  test('same thread different task — child approved for task A cannot claim task B', async () => {
    const TASK_B_ID = 'task-f322-b';
    const resolver = buildResolver({
      task: makeTask({ id: TASK_B_ID }),
      delegates: [APPROVED_DELEGATE],
    });
    const { service } = buildAdmission(resolver);
    const req = admissionRequest();

    await assert.rejects(
      service.admit({
        ...req,
        action: { ...req.action, subjectRef: `subject:task:${TASK_B_ID}` },
      }),
      (err) => err instanceof ActionSuccessorStandingError,
      'child approved for task A should not get standing for task B in same thread',
    );
  });

  // ── Negative 2: missing/tampered proposal ──

  test('missing proposal — delegate provider returns empty → child rejected', async () => {
    const resolver = buildResolver({ delegates: [] });
    const { service } = buildAdmission(resolver);
    await assert.rejects(
      service.admit(admissionRequest()),
      (err) => err instanceof ActionSuccessorStandingError && err.mismatchDimensions.includes('owner'),
      'missing proposal should fail closed',
    );
  });

  // ── Negative 3: non-approved proposal status ──

  test('withdrawn/rejected proposal — provider excludes non-approved → child rejected', async () => {
    const resolver = buildResolver({ delegates: [] });
    const { service } = buildAdmission(resolver);
    await assert.rejects(
      service.admit(admissionRequest()),
      (err) => err instanceof ActionSuccessorStandingError,
      'non-approved proposal should fail closed',
    );
  });

  // ── Negative 4: task owner changed ──

  test('task owner changed after approval — delegate not proven valid under new owner (P1-2)', async () => {
    const resolver = buildResolver({
      task: makeTask({ ownerCatId: 'new-owner-cat' }),
      delegates: [APPROVED_DELEGATE],
    });
    const { service } = buildAdmission(resolver);

    await assert.rejects(
      service.admit(admissionRequest()),
      (err) => err instanceof ActionSuccessorStandingError,
      'delegate not proven valid under changed owner should fail closed',
    );

    await assert.rejects(
      service.admit(
        admissionRequest({
          actorCatId: OWNER_CAT,
          sourceThreadId: OWNER_THREAD,
          targetThreadId: OWNER_THREAD,
          holderCatIds: [OWNER_CAT],
        }),
      ),
      (err) => err instanceof ActionSuccessorStandingError && err.mismatchDimensions.includes('owner'),
      'old owner should fail standing after transfer',
    );
  });

  // ── Negative 5: no delegate provider ──

  test('no delegate provider → resolver returns no delegates → child rejected', async () => {
    const resolver = new ActionSubjectTruthResolver(
      {
        async getSubjectTerminal() {
          return null;
        },
        async markSubjectTerminal(input) {
          return { subjectRef: input.subjectRef, state: input.state, observedAt: input.now };
        },
        async clearSubjectTerminal() {},
      },
      {
        async get() {
          return null;
        },
      },
      undefined,
      {
        async get(id) {
          return id === TASK_ID ? makeTask() : null;
        },
      },
      undefined,
    );
    const { service } = buildAdmission(resolver);
    await assert.rejects(
      service.admit(admissionRequest()),
      (err) => err instanceof ActionSuccessorStandingError,
      'no delegate provider = fail closed',
    );
  });

  // ── exact owner regression ──

  test('exact owner still admitted through resolver path (regression)', async () => {
    const resolver = buildResolver({ delegates: [] });
    const { service } = buildAdmission(resolver);
    const result = await service.admit(
      admissionRequest({
        actorCatId: OWNER_CAT,
        sourceThreadId: OWNER_THREAD,
        targetThreadId: OWNER_THREAD,
        holderCatIds: [OWNER_CAT],
      }),
    );
    assert.equal(result.admit, true, 'exact owner should always pass');
  });
});
