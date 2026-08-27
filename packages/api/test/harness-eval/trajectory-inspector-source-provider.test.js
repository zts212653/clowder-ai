import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TrajectoryInspectorSourceProviderImpl } from '../../dist/infrastructure/harness-eval/trajectory-inspector/trajectory-inspector-source-provider.js';

const session = {
  id: 'session-owner',
  threadId: 'thread-owner',
  catId: 'codex-sol',
  userId: 'owner',
  seq: 0,
  status: 'sealed',
};

function envelope(eventNo, invocationId, t, event, overrides = {}) {
  return {
    v: 1,
    t,
    threadId: 'thread-owner',
    catId: 'codex-sol',
    sessionId: 'session-owner',
    invocationId,
    eventNo,
    event,
    ...overrides,
  };
}

function terminal(eventNo, invocationId, t) {
  return envelope(eventNo, invocationId, t, { type: 'error', errorCode: 'provider_failed' });
}

function drill(eventNo, invocationId, t, targetInvocationId, toolUseId, hints = {}) {
  return envelope(eventNo, invocationId, t, {
    type: 'tool_use',
    toolName: 'mcp:cat-cafe-memory/cat_cafe_read_invocation_detail',
    toolUseId,
    toolInput: { invocationId: targetInvocationId, ...hints },
  });
}

function toolResult(eventNo, invocationId, t, toolUseId) {
  return envelope(eventNo, invocationId, t, {
    type: 'tool_result',
    toolUseId,
    toolResultStatus: 'success',
  });
}

function buildProvider(events) {
  const canonical = new Map([
    ['inv-accepted', { threadId: 'thread-owner', sessionId: 'session-owner' }],
    ['inv-unresolved', { threadId: 'thread-owner', sessionId: 'session-owner' }],
    ['inv-silent', { threadId: 'thread-owner', sessionId: 'session-owner' }],
    ['inv-wrong', { threadId: 'thread-owner', sessionId: 'session-owner' }],
    ['inv-finding', { threadId: 'thread-owner', sessionId: 'session-owner' }],
  ]);
  return new TrajectoryInspectorSourceProviderImpl({
    threadStore: { list: async (ownerUserId) => (ownerUserId === 'owner' ? [{ id: 'thread-owner' }] : []) },
    sessionChainStore: {
      getChainByThread: async () => [session, { ...session, id: 'session-foreign', userId: 'foreign' }],
    },
    transcriptReader: {
      hasTranscript: async (sessionId) => sessionId === 'session-owner',
      readAllEvents: async (sessionId) => (sessionId === 'session-owner' ? events : []),
    },
    canonicalResolver: async (input) => {
      const resolved = canonical.get(input.invocationId);
      if (!resolved) return { status: 404, body: { code: 'INVOCATION_RECORD_NOT_FOUND' } };
      if (input.threadIdHint && input.threadIdHint !== resolved.threadId) {
        return { status: 409, body: { code: 'INVOCATION_THREAD_HINT_MISMATCH' } };
      }
      if (input.sessionIdHint && input.sessionIdHint !== resolved.sessionId) {
        return { status: 409, body: { code: 'INVOCATION_SESSION_HINT_MISMATCH' } };
      }
      return { status: 200, body: { invocationId: input.invocationId, ...resolved } };
    },
    externalEvidenceSource: {
      listFindings: async () => [
        {
          invocationId: 'inv-finding',
          foundAtMs: 1_400,
          sourceRefs: ['snapshot:f192-finding'],
        },
      ],
      listAcceptedEvidence: async () => [
        {
          invocationId: 'inv-accepted',
          acceptedAtMs: 1_500,
          reviewerAgreement: 'agreed',
          sourceRefs: ['attribution:f192-accepted'],
        },
      ],
      hasComparableBaseline: async () => false,
    },
  });
}

describe('trajectory inspector transcript source provider', () => {
  it('projects owner-scoped anomaly opportunities without dropping silent or F192-only episodes', async () => {
    const events = [
      terminal(1, 'inv-accepted', 1_000),
      terminal(2, 'inv-unresolved', 1_100),
      terminal(3, 'inv-silent', 1_200),
      terminal(4, 'inv-wrong', 1_300),
      drill(5, 'investigator', 1_450, 'inv-accepted', 'tool-accepted', {
        threadId: 'thread-owner',
        sessionId: 'session-owner',
      }),
      toolResult(6, 'investigator', 1_500, 'tool-accepted'),
      // Replayed envelopes share the stable toolUseId and must not create a second investigation.
      drill(7, 'investigator', 1_550, 'inv-accepted', 'tool-accepted', {
        threadId: 'thread-owner',
        sessionId: 'session-owner',
      }),
      toolResult(8, 'investigator', 1_560, 'tool-accepted'),
      drill(9, 'investigator', 1_600, 'inv-unresolved', 'tool-unresolved', {
        threadId: 'thread-owner',
        sessionId: 'session-owner',
      }),
      toolResult(10, 'investigator', 1_620, 'tool-unresolved'),
      envelope(11, 'investigator', 1_650, {
        type: 'tool_use',
        toolName: 'command_execution',
        toolUseId: 'raw-fallback',
        toolInput: { command: "rg 'inv-unresolved' data/transcripts/**/events.jsonl" },
      }),
      envelope(12, 'investigator', 1_660, {
        type: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'bash-fallback',
        toolInput: { command: "rg 'inv-silent' data/transcripts/**/events.jsonl" },
      }),
      envelope(13, 'investigator', 1_670, {
        type: 'tool_use',
        toolName: 'Shell',
        toolUseId: 'shell-fallback',
        toolInput: { command: "rg 'inv-finding' data/transcripts/**/events.jsonl" },
      }),
      drill(14, 'investigator', 1_700, 'inv-wrong', 'tool-wrong', {
        threadId: 'thread-other',
        sessionId: 'session-other',
      }),
      toolResult(15, 'investigator', 1_720, 'tool-wrong'),
    ];

    const bundle = await buildProvider(events).resolve(
      { kind: 'trajectory-inspector-window', windowStartMs: 900, windowEndMs: 2_000 },
      { ownerUserId: 'owner' },
    );

    assert.deepEqual(
      bundle.episodes.map((row) => row.episodeId),
      [
        'trajectory:inv-accepted',
        'trajectory:inv-finding',
        'trajectory:inv-silent',
        'trajectory:inv-unresolved',
        'trajectory:inv-wrong',
      ],
    );
    assert.equal(bundle.episodes.find((row) => row.invocationId === 'inv-accepted').evidenceOutcome, 'accepted');
    assert.equal(bundle.episodes.find((row) => row.invocationId === 'inv-finding').evidenceOutcome, 'unresolved');
    assert.equal(bundle.episodes.find((row) => row.invocationId === 'inv-finding').rawOrJsonlFallback, true);
    assert.equal(bundle.episodes.find((row) => row.invocationId === 'inv-silent').evidenceOutcome, 'unresolved');
    assert.equal(bundle.episodes.find((row) => row.invocationId === 'inv-silent').rawOrJsonlFallback, true);
    assert.equal(bundle.episodes.find((row) => row.invocationId === 'inv-unresolved').evidenceOutcome, 'unresolved');
    assert.equal(bundle.episodes.find((row) => row.invocationId === 'inv-unresolved').rawOrJsonlFallback, true);
    assert.equal(bundle.episodes.find((row) => row.invocationId === 'inv-wrong').evidenceOutcome, 'wrong_ref');
    assert.equal(bundle.vector.eligibleEpisodes, 5);
    assert.equal(bundle.vector.rawOrJsonlFallbackCount, 3);
    assert.equal(
      bundle.vector.accepted + bundle.vector.unresolved + bundle.vector.notTaken + bundle.vector.wrongRef,
      5,
    );
    assert.equal(bundle.stopUtilityConclusion, true);
  });

  it('is deterministic across event replay order and degrades validity for missing owner transcripts', async () => {
    const events = [terminal(1, 'inv-silent', 1_200)];
    const provider = buildProvider(events);
    const selector = { kind: 'trajectory-inspector-window', windowStartMs: 900, windowEndMs: 2_000 };
    const first = await provider.resolve(selector, { ownerUserId: 'owner' });
    const second = await provider.resolve(selector, { ownerUserId: 'owner' });
    assert.deepEqual(first, second);

    const missing = new TrajectoryInspectorSourceProviderImpl({
      threadStore: { list: async () => [{ id: 'thread-owner' }] },
      sessionChainStore: { getChainByThread: async () => [session] },
      transcriptReader: { hasTranscript: async () => false, readAllEvents: async () => [] },
      canonicalResolver: async () => ({ status: 404, body: { code: 'INVOCATION_RECORD_NOT_FOUND' } }),
      externalEvidenceSource: {
        listFindings: async () => [],
        listAcceptedEvidence: async () => [],
        hasComparableBaseline: async () => false,
      },
    });
    const missingBundle = await missing.resolve(selector, { ownerUserId: 'owner' });
    assert.equal(missingBundle.validity.status, 'calibration_only');
    assert.ok(missingBundle.validity.reasons.includes('canonical_coverage_degraded'));
    assert.equal(missingBundle.sourceHealth.missingTranscriptSessions, 1);
  });

  it('keeps a drill without toolUseId fail-closed because no result can be correlated', async () => {
    const events = [
      terminal(1, 'inv-silent', 1_200),
      envelope(2, 'investigator', 1_300, {
        type: 'tool_use',
        toolName: 'mcp:cat-cafe-memory/cat_cafe_read_invocation_detail',
        toolInput: { invocationId: 'inv-silent' },
      }),
      envelope(3, 'investigator', 1_350, {
        type: 'tool_result',
        toolResultStatus: 'success',
      }),
    ];

    const bundle = await buildProvider(events).resolve(
      { kind: 'trajectory-inspector-window', windowStartMs: 900, windowEndMs: 2_000 },
      { ownerUserId: 'owner' },
    );

    assert.equal(bundle.episodes.find((row) => row.invocationId === 'inv-silent').evidenceOutcome, 'not_taken');
  });

  it('rejects unbounded, reversed, oversized, and caller-authored source selectors', async () => {
    const provider = buildProvider([]);
    await assert.rejects(
      provider.resolve(
        { kind: 'trajectory-inspector-window', windowStartMs: 2_000, windowEndMs: 1_000 },
        { ownerUserId: 'owner' },
      ),
      /windowEndMs/,
    );
    await assert.rejects(
      provider.resolve(
        { kind: 'trajectory-inspector-window', windowStartMs: 0, windowEndMs: 32 * 24 * 60 * 60 * 1_000 },
        { ownerUserId: 'owner' },
      ),
      /31 days/,
    );
    await assert.rejects(
      provider.resolve(
        { kind: 'trajectory-inspector-window', windowStartMs: 0, windowEndMs: 1_000, episodes: [] },
        { ownerUserId: 'owner' },
      ),
      /unrecognized key/i,
    );
  });
});
