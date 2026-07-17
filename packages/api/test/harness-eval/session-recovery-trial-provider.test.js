import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SessionRecoveryTrialProvider,
  validateSessionRecoverySelector,
} from '../../dist/infrastructure/harness-eval/session-recovery/session-recovery-trial-provider.js';

const OWNER = 'owner-1';

function session(overrides = {}) {
  return {
    id: 'source-1',
    cliSessionId: 'cli-source',
    threadId: 'thread-1',
    catId: 'cat-1',
    userId: OWNER,
    seq: 0,
    status: 'sealed',
    sealReason: 'threshold',
    sealedAt: 1_500,
    messageCount: 2,
    createdAt: 1_000,
    updatedAt: 1_500,
    ...overrides,
  };
}

function target(overrides = {}) {
  return session({
    id: 'target-1',
    cliSessionId: 'cli-target',
    seq: 1,
    status: 'active',
    messageCount: 1,
    createdAt: 2_000,
    updatedAt: 2_000,
    sealedAt: undefined,
    sealReason: undefined,
    continuedFromSessionId: 'source-1',
    openedByInvocationId: 'inv-1',
    ...overrides,
  });
}

function transcriptEvent(eventNo, event, invocationId = 'inv-1') {
  return {
    v: 1,
    t: 2_000 + eventNo,
    threadId: 'thread-1',
    catId: 'cat-1',
    sessionId: 'target-1',
    cliSessionId: 'cli-target',
    invocationId,
    eventNo,
    event,
  };
}

function providerFor(records, events = []) {
  const byId = new Map(records.map((record) => [record.id, record]));
  return new SessionRecoveryTrialProvider({
    sessionStore: {
      scanContinuationTargets(query) {
        return records
          .filter((record) => record.userId === query.ownerUserId)
          .filter((record) => record.continuedFromSessionId)
          .filter((record) => record.createdAt >= query.windowStartMs && record.createdAt < query.windowEndMs)
          .filter((record) => !query.catId || record.catId === query.catId)
          .filter((record) => !query.threadId || record.threadId === query.threadId)
          .slice(0, query.limit);
      },
      get(id) {
        return byId.get(id) ?? null;
      },
    },
    transcriptReader: {
      async readEvents() {
        return { events, total: events.length };
      },
    },
  });
}

const SELECTOR = {
  kind: 'session-recovery-window',
  windowStartMs: 1_900,
  windowEndMs: 3_000,
  limit: 10,
};

describe('SessionRecoveryTrialProvider', () => {
  it('projects opening-invocation anchors without server-side first-action semantics or transcript bodies', async () => {
    const source = session();
    const next = target();
    const events = [
      transcriptEvent(0, { type: 'session_init' }),
      transcriptEvent(1, { type: 'text', text: 'private transcript body' }),
      transcriptEvent(2, { type: 'done' }),
    ];
    const [trial] = await providerFor([source, next], events).resolve(SELECTOR, { ownerUserId: OWNER });

    assert.equal(trial.trialId, 'session-recovery:target-1');
    assert.equal(trial.source.sessionId, 'source-1');
    assert.equal(trial.target.sessionId, 'target-1');
    assert.equal(trial.firstInvocationId, 'inv-1');
    assert.equal(trial.firstMeaningfulEventRef, undefined);
    assert.ok(trial.evidenceRefs.includes('transcript:target-1:event:1'));
    assert.equal(trial.terminalEventRef, 'transcript:target-1:event:2');
    assert.equal(JSON.stringify(trial).includes('private transcript body'), false);
  });

  it('does not mark an exhausted multi-page opening transcript as truncated', async () => {
    const source = session();
    const next = target();
    let page = 0;
    const provider = new SessionRecoveryTrialProvider({
      sessionStore: {
        scanContinuationTargets() {
          return [next];
        },
        get() {
          return source;
        },
      },
      transcriptReader: {
        async readEvents() {
          page += 1;
          if (page === 1) {
            return {
              events: [transcriptEvent(0, { type: 'session_init' })],
              nextCursor: { eventNo: 1 },
              total: 2,
            };
          }
          return { events: [transcriptEvent(1, { type: 'done' })], total: 2 };
        },
      },
    });

    const [trial] = await provider.resolve(SELECTOR, { ownerUserId: OWNER });

    assert.equal(trial.transcriptEvidenceStatus, 'available');
    assert.equal(trial.transcriptEvidenceTruncated, undefined);
  });

  it('bounds the opening-event publish allowlist at the same 100 anchors exposed by the evidence reader', async () => {
    const source = session();
    const next = target();
    const firstPage = Array.from({ length: 100 }, (_, eventNo) =>
      transcriptEvent(eventNo, { type: eventNo === 99 ? 'tool_use' : 'text' }),
    );
    const provider = new SessionRecoveryTrialProvider({
      sessionStore: {
        scanContinuationTargets() {
          return [next];
        },
        get(id) {
          return id === source.id ? source : next;
        },
      },
      transcriptReader: {
        async readEvents(_sessionId, _threadId, _catId, cursor, limit) {
          assert.equal(cursor, undefined);
          assert.equal(limit, 100);
          return { events: firstPage, nextCursor: { eventNo: 100 }, total: 150 };
        },
      },
    });

    const [trial] = await provider.resolve(SELECTOR, { ownerUserId: OWNER });

    assert.equal(trial.transcriptEvidenceTruncated, true);
    assert.ok(trial.evidenceRefs.includes('transcript:target-1:event:99'));
    assert.ok(!trial.evidenceRefs.includes('transcript:target-1:event:100'));
    await assert.rejects(
      provider.resolve(
        {
          ...SELECTOR,
          assessments: [
            {
              trialId: trial.trialId,
              stateReconstruction: 'recovered',
              firstMeaningfulAction: 'aligned',
              firstMeaningfulEventRef: 'transcript:target-1:event:149',
              outcome: 'continued',
              evidenceRefs: ['session:source-1', 'transcript:target-1:event:149'],
              rationale: 'A reader-only anchor must not be publishable.',
            },
          ],
        },
        { ownerUserId: OWNER },
      ),
      /foreign assessment evidence ref/,
    );
  });

  it('keeps semantics unknown until an evidence-grounded assessment is supplied', async () => {
    const records = [session(), target()];
    const events = [transcriptEvent(1, { type: 'text', text: 'body' }), transcriptEvent(2, { type: 'done' })];
    const provider = providerFor(records, events);
    const [unassessed] = await provider.resolve(SELECTOR, { ownerUserId: OWNER });
    assert.equal(unassessed.assessment, undefined);

    const [assessed] = await provider.resolve(
      {
        ...SELECTOR,
        assessments: [
          {
            trialId: unassessed.trialId,
            stateReconstruction: 'stale',
            firstMeaningfulAction: 'misaligned',
            firstMeaningfulEventRef: 'transcript:target-1:event:1',
            outcome: 'failed',
            evidenceRefs: ['invocation:inv-1', 'transcript:target-1:event:1'],
            rationale: 'Target acted from stale state.',
          },
        ],
      },
      { ownerUserId: OWNER },
    );
    assert.equal(assessed.assessment.stateReconstruction, 'stale');
  });

  it('does not fabricate missing-target trials and fails closed on an invalid backlink', async () => {
    const source = session();
    assert.deepEqual(await providerFor([source]).resolve(SELECTOR, { ownerUserId: OWNER }), []);

    const invalid = target({ continuedFromSessionId: 'missing-source' });
    await assert.rejects(
      providerFor([source, invalid]).resolve(SELECTOR, { ownerUserId: OWNER }),
      /invalid_continuation_target: source not found/,
    );
  });

  it('requires owner scope and pushes owner plus optional filters into target discovery', async () => {
    let captured;
    const source = session();
    const next = target();
    const provider = new SessionRecoveryTrialProvider({
      sessionStore: {
        scanContinuationTargets(query) {
          captured = query;
          return [next];
        },
        get() {
          return source;
        },
      },
      transcriptReader: {
        async readEvents() {
          return { events: [], total: 0 };
        },
      },
    });
    await assert.rejects(provider.resolve(SELECTOR), /owner_user_required/);
    await provider.resolve({ ...SELECTOR, catId: 'cat-1', threadId: 'thread-1' }, { ownerUserId: OWNER });
    assert.deepEqual(captured, {
      ownerUserId: OWNER,
      windowStartMs: 1_900,
      windowEndMs: 3_000,
      catId: 'cat-1',
      threadId: 'thread-1',
      limit: 10,
    });
  });

  it('re-resolves one trial only inside the authenticated owner and selector filters', async () => {
    const provider = providerFor(
      [session(), target()],
      [transcriptEvent(1, { type: 'tool_use', name: 'exec_command' }), transcriptEvent(2, { type: 'done' })],
    );
    const trial = await provider.resolveTrial(SELECTOR, 'session-recovery:target-1', { ownerUserId: OWNER });
    assert.equal(trial.target.sessionId, 'target-1');
    await assert.rejects(
      provider.resolveTrial(SELECTOR, 'session-recovery:target-1', { ownerUserId: 'other-owner' }),
      /session_recovery_evidence_not_found/,
    );
    await assert.rejects(
      provider.resolveTrial({ ...SELECTOR, catId: 'other-cat' }, 'session-recovery:target-1', {
        ownerUserId: OWNER,
      }),
      /session_recovery_evidence_not_found/,
    );
  });

  it('rejects forged evidence refs and unknown target trial IDs', async () => {
    const provider = providerFor(
      [session(), target()],
      [transcriptEvent(1, { type: 'text', text: 'body' }), transcriptEvent(2, { type: 'done' })],
    );
    const assessment = {
      trialId: 'session-recovery:target-1',
      stateReconstruction: 'recovered',
      firstMeaningfulAction: 'aligned',
      firstMeaningfulEventRef: 'transcript:target-1:event:1',
      outcome: 'continued',
      evidenceRefs: ['session:foreign'],
      rationale: 'forged',
    };
    await assert.rejects(
      provider.resolve({ ...SELECTOR, assessments: [assessment] }, { ownerUserId: OWNER }),
      /foreign assessment evidence ref/,
    );
    await assert.rejects(
      provider.resolve(
        { ...SELECTOR, assessments: [{ ...assessment, trialId: 'session-recovery:unknown' }] },
        { ownerUserId: OWNER },
      ),
      /unknown assessment trial/,
    );
  });

  it('accepts the eval-cat-selected first meaningful event only when it belongs to the opening invocation', async () => {
    const provider = providerFor(
      [session(), target()],
      [
        transcriptEvent(1, { type: 'text', text: 'I will first inspect the current state.' }),
        transcriptEvent(2, { type: 'tool_use', name: 'exec_command' }),
        transcriptEvent(3, { type: 'done' }),
        transcriptEvent(4, { type: 'tool_use', name: 'apply_patch' }, 'inv-later'),
      ],
    );
    const assessment = {
      trialId: 'session-recovery:target-1',
      stateReconstruction: 'recovered',
      firstMeaningfulAction: 'aligned',
      firstMeaningfulEventRef: 'transcript:target-1:event:2',
      outcome: 'continued',
      evidenceRefs: ['session:source-1', 'transcript:target-1:event:2'],
      rationale: 'The status sentence is not the substantive action; the selected tool call advances current work.',
    };

    const [trial] = await provider.resolve({ ...SELECTOR, assessments: [assessment] }, { ownerUserId: OWNER });
    assert.equal(trial.assessment.firstMeaningfulEventRef, 'transcript:target-1:event:2');

    await assert.rejects(
      provider.resolve(
        {
          ...SELECTOR,
          assessments: [
            {
              ...assessment,
              evidenceRefs: ['session:source-1', 'transcript:target-1:event:1'],
            },
          ],
        },
        { ownerUserId: OWNER },
      ),
      /first meaningful event evidence ref is required/,
    );

    await assert.rejects(
      provider.resolve(
        {
          ...SELECTOR,
          assessments: [
            {
              ...assessment,
              firstMeaningfulEventRef: 'transcript:other-target:event:2',
              evidenceRefs: ['session:source-1', 'transcript:target-1:event:2'],
            },
          ],
        },
        { ownerUserId: OWNER },
      ),
      /foreign first meaningful event ref/,
    );
    await assert.rejects(
      provider.resolve(
        {
          ...SELECTOR,
          assessments: [
            {
              ...assessment,
              firstMeaningfulEventRef: 'transcript:target-1:event:4',
              evidenceRefs: ['session:source-1', 'transcript:target-1:event:2'],
            },
          ],
        },
        { ownerUserId: OWNER },
      ),
      /foreign first meaningful event ref/,
    );
  });

  it('marks transcript read failures and rejects semantic claims without transcript anchors', async () => {
    const records = [session(), target()];
    const provider = new SessionRecoveryTrialProvider({
      sessionStore: {
        scanContinuationTargets() {
          return [records[1]];
        },
        get() {
          return records[0];
        },
      },
      transcriptReader: {
        async readEvents() {
          throw new Error('disk unavailable');
        },
      },
    });
    const [trial] = await provider.resolve(SELECTOR, { ownerUserId: OWNER });
    assert.equal(trial.transcriptEvidenceStatus, 'read_failed');
    await assert.rejects(
      provider.resolve(
        {
          ...SELECTOR,
          assessments: [
            {
              trialId: trial.trialId,
              stateReconstruction: 'recovered',
              firstMeaningfulAction: 'unknown',
              outcome: 'unknown',
              evidenceRefs: ['session:target-1'],
              rationale: 'Cannot claim this without transcript evidence.',
            },
          ],
        },
        { ownerUserId: OWNER },
      ),
      /requires available transcript evidence/,
    );
  });

  it('validates bounded target-creation selectors', () => {
    assert.equal(validateSessionRecoverySelector(SELECTOR), null);
    assert.match(validateSessionRecoverySelector({ ...SELECTOR, windowEndMs: 1_000 }), /must be >/);
    assert.match(validateSessionRecoverySelector({ ...SELECTOR, limit: 201 }), /between 1 and 200/);
    assert.match(validateSessionRecoverySelector({ ...SELECTOR, threadId: 'bad\nthread' }), /single-line/);
  });
});
