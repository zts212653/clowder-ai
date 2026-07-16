import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SessionRecoveryTrialProvider,
  validateSessionRecoverySelector,
} from '../../dist/infrastructure/harness-eval/session-recovery/index.js';

const OWNER = 'owner-1';

function session(overrides) {
  return {
    id: overrides.id,
    cliSessionId: `${overrides.id}-cli`,
    threadId: 'thread-1',
    catId: 'codex',
    userId: OWNER,
    seq: 0,
    status: 'sealed',
    messageCount: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
    sealedAt: 2_000,
    sealReason: 'threshold',
    ...overrides,
  };
}

function explicitTarget(source, overrides = {}) {
  return session({
    id: 'target-1',
    seq: source.seq + 1,
    status: 'sealed',
    createdAt: 2_100,
    updatedAt: 2_900,
    sealedAt: 2_900,
    openedByInvocationId: 'inv-target-1',
    continuationOrigin: {
      sourceSessionId: source.id,
      sourceSeq: source.seq,
      kind: 'threshold',
      sealReason: 'threshold',
    },
    recoveryDelivery: {
      sourceSessionId: source.id,
      providerDispatchAt: 2_050,
      bootstrapContentHash: `sha256:${'a'.repeat(64)}`,
      bootstrapIncludedInPrompt: true,
      handoffNoteIncluded: false,
    },
    ...overrides,
  });
}

function provider(records, eventsByInvocation = {}) {
  return new SessionRecoveryTrialProvider({
    sessionStore: { scanAll: async () => records },
    transcriptReader: {
      readEvents: async (_sessionId, _threadId, _catId, cursor, limit = 100) => {
        const events = Object.values(eventsByInvocation).flat();
        const start = cursor?.eventNo ?? 0;
        const page = events.filter((item) => item.eventNo >= start).slice(0, limit);
        const last = page.at(-1);
        return {
          events: page,
          total: events.length,
          ...(last && last.eventNo + 1 < events.length ? { nextCursor: { eventNo: last.eventNo + 1 } } : {}),
        };
      },
    },
  });
}

function event(target, eventNo, type, content = undefined) {
  return {
    v: 1,
    t: 2_200 + eventNo,
    threadId: target.threadId,
    catId: target.catId,
    sessionId: target.id,
    cliSessionId: target.cliSessionId,
    invocationId: target.openedByInvocationId,
    eventNo,
    event: { type, ...(content ? { content } : {}) },
  };
}

const SELECTOR = {
  kind: 'session-recovery-window',
  windowStartMs: 1_500,
  windowEndMs: 3_000,
  limit: 20,
};

describe('SessionRecoveryTrialProvider', () => {
  it('projects an explicit clean transition without copying transcript bodies', async () => {
    const source = session({ id: 'source-1' });
    const target = explicitTarget(source);
    const secret = 'private transcript body must not enter the trial';
    const trials = await provider([source, target], {
      'inv-target-1': [event(target, 0, 'system_info'), event(target, 1, 'text', secret), event(target, 2, 'done')],
    }).resolve(SELECTOR, { ownerUserId: OWNER });

    assert.equal(trials.length, 1);
    assert.equal(trials[0].trialId, 'session-recovery:source-1');
    assert.equal(trials[0].lineage, 'explicit');
    assert.equal(trials[0].transitionIntegrity, 'pass');
    assert.equal(trials[0].delivery, 'provider_dispatched');
    assert.equal(trials[0].firstInvocationId, 'inv-target-1');
    assert.equal(trials[0].firstMeaningfulEventRef, 'transcript:target-1:event:1');
    assert.equal(trials[0].assessment, undefined);
    assert.doesNotMatch(JSON.stringify(trials[0]), new RegExp(secret));
  });

  it('keeps stale semantics unknown until an explicit assessment is supplied', async () => {
    const source = session({ id: 'source-stale' });
    const target = explicitTarget(source, { id: 'target-stale', openedByInvocationId: 'inv-stale' });
    const assessment = {
      trialId: 'session-recovery:source-stale',
      stateReconstruction: 'stale',
      firstMeaningfulAction: 'misaligned',
      outcome: 'failed',
      evidenceRefs: ['invocation:inv-stale'],
      rationale: 'The eval cat compared the action with live branch truth.',
    };
    const trials = await provider([source, target]).resolve(
      { ...SELECTOR, assessments: [assessment] },
      { ownerUserId: OWNER },
    );

    assert.deepEqual(trials[0].assessment, assessment);
  });

  it('surfaces missing, duplicate, cross-identity, and legacy transitions honestly', async () => {
    const missing = session({ id: 'source-missing', seq: 0, sealReason: 'cat_initiated_handoff' });
    const duplicate = session({ id: 'source-duplicate', seq: 10 });
    const dupA = explicitTarget(duplicate, { id: 'dup-a', seq: 11, openedByInvocationId: 'inv-dup-a' });
    const dupB = explicitTarget(duplicate, { id: 'dup-b', seq: 11, openedByInvocationId: 'inv-dup-b' });
    const cross = session({ id: 'source-cross', seq: 20 });
    const crossTarget = explicitTarget(cross, {
      id: 'cross-target',
      seq: 21,
      threadId: 'wrong-thread',
      openedByInvocationId: 'inv-cross',
    });
    const legacy = session({ id: 'source-legacy', seq: 30 });
    const legacyCandidate = session({
      id: 'legacy-target',
      seq: 31,
      status: 'active',
      createdAt: 2_100,
      updatedAt: 2_100,
      sealedAt: undefined,
      openedByInvocationId: undefined,
      continuationOrigin: undefined,
      recoveryDelivery: undefined,
    });

    const trials = await provider([
      missing,
      duplicate,
      dupA,
      dupB,
      cross,
      crossTarget,
      legacy,
      legacyCandidate,
    ]).resolve(SELECTOR, { ownerUserId: OWNER });
    const byId = new Map(trials.map((trial) => [trial.trialId, trial]));

    assert.equal(byId.get('session-recovery:source-missing').lineage, 'missing');
    assert.equal(byId.get('session-recovery:source-missing').delivery, 'missing_target');
    assert.equal(byId.get('session-recovery:source-duplicate').lineage, 'duplicate');
    assert.equal(byId.get('session-recovery:source-duplicate').duplicateTargets.length, 2);
    assert.equal(byId.get('session-recovery:source-cross').transitionIntegrity, 'fail');
    assert.ok(byId.get('session-recovery:source-cross').structuralIssues.includes('target_identity_mismatch'));
    assert.equal(byId.get('session-recovery:source-legacy').lineage, 'legacy_unlinked');
    assert.equal(byId.get('session-recovery:source-legacy').transitionIntegrity, 'unknown');
    assert.equal(byId.get('session-recovery:source-legacy').inferredTarget.sessionId, 'legacy-target');
  });

  it('requires owner scope, filters foreign sources, and rejects forged assessments', async () => {
    const own = session({ id: 'own-source', sealReason: 'cat_initiated_handoff' });
    const foreign = session({ id: 'foreign-source', userId: 'owner-2', sealReason: 'cat_initiated_handoff' });
    const p = provider([own, foreign]);

    await assert.rejects(p.resolve(SELECTOR), /owner_user_required/);
    const trials = await p.resolve(SELECTOR, { ownerUserId: OWNER });
    assert.deepEqual(
      trials.map((trial) => trial.source.sessionId),
      ['own-source'],
    );
    await assert.rejects(
      p.resolve(
        {
          ...SELECTOR,
          assessments: [
            {
              trialId: 'session-recovery:not-in-window',
              stateReconstruction: 'recovered',
              firstMeaningfulAction: 'aligned',
              outcome: 'continued',
              evidenceRefs: ['session:not-in-window'],
              rationale: 'forged',
            },
          ],
        },
        { ownerUserId: OWNER },
      ),
      /unknown assessment trial/i,
    );
  });

  it('validates bounded selectors', () => {
    assert.equal(validateSessionRecoverySelector(SELECTOR), null);
    assert.match(validateSessionRecoverySelector({ ...SELECTOR, windowEndMs: 1_500 }), /windowEndMs/);
    assert.match(validateSessionRecoverySelector({ ...SELECTOR, limit: 201 }), /limit/);
    assert.match(
      validateSessionRecoverySelector({ ...SELECTOR, windowEndMs: SELECTOR.windowStartMs + 32 * 86_400_000 }),
      /31 days/,
    );
  });

  it('fails closed when the bounded session scan saturates', async () => {
    const records = Array.from({ length: 1_000 }, (_, index) =>
      session({ id: `saturated-${index}`, userId: 'foreign-owner' }),
    );
    await assert.rejects(provider(records).resolve(SELECTOR, { ownerUserId: OWNER }), /session_scan_limit_reached/);
  });
});
