import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TrajectoryInspectorSourceProviderImpl } from '../../dist/infrastructure/harness-eval/trajectory-inspector/trajectory-inspector-source-provider.js';

const baseSession = {
  id: 'session-owner',
  threadId: 'thread-owner',
  catId: 'codex-sol',
  userId: 'owner',
  seq: 0,
  status: 'sealed',
  createdAt: 800,
  updatedAt: 1_800,
  sealedAt: 1_800,
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

const noExternalEvidence = {
  listFindings: async () => [],
  listAcceptedEvidence: async () => [],
  hasComparableBaseline: async () => false,
};

describe('trajectory inspector bounded transcript scanning', () => {
  it('filters session lifetimes before transcript IO and caps concurrent scans at two', async () => {
    const activeSessions = Array.from({ length: 6 }, (_, index) => ({
      ...baseSession,
      id: `session-active-${index}`,
      threadId: `thread-active-${index}`,
      seq: index,
      createdAt: 950,
      updatedAt: 1_700,
      sealedAt: 1_700,
    }));
    const staleSession = {
      ...baseSession,
      id: 'session-stale',
      threadId: 'thread-stale',
      createdAt: 0,
      updatedAt: 500,
      sealedAt: 500,
    };
    const sessionsByThread = new Map([
      ...activeSessions.map((record) => [record.threadId, [record]]),
      [staleSession.threadId, [staleSession]],
    ]);
    const scanned = [];
    let activeScans = 0;
    let maxActiveScans = 0;
    const provider = new TrajectoryInspectorSourceProviderImpl({
      threadStore: { list: async () => [...sessionsByThread.keys()].map((id) => ({ id })) },
      sessionChainStore: { getChainByThread: async (threadId) => sessionsByThread.get(threadId) ?? [] },
      transcriptReader: {
        scanEvents: async (sessionId, threadId, _catId, visitor) => {
          scanned.push(sessionId);
          activeScans += 1;
          maxActiveScans = Math.max(maxActiveScans, activeScans);
          await new Promise((resolve) => setTimeout(resolve, 2));
          await visitor(
            envelope(
              1,
              `inv-${sessionId}`,
              1_200,
              { type: 'error', errorCode: 'provider_failed' },
              {
                threadId,
                sessionId,
              },
            ),
          );
          activeScans -= 1;
          return { present: true, eventCount: 1 };
        },
      },
      canonicalResolver: async (input) => ({
        status: 200,
        body: { invocationId: input.invocationId, threadId: input.threadIdHint, sessionId: input.sessionIdHint },
      }),
      externalEvidenceSource: noExternalEvidence,
    });

    const bundle = await provider.resolve(
      { kind: 'trajectory-inspector-window', windowStartMs: 900, windowEndMs: 2_000 },
      { ownerUserId: 'owner' },
    );

    assert.equal(bundle.episodes.length, 6);
    assert.equal(scanned.includes('session-stale'), false);
    assert.ok(maxActiveScans <= 2, `observed ${maxActiveScans} concurrent transcript scans`);
  });

  it('keeps active and sealing session intervals open until an authoritative seal', async () => {
    const sessions = [
      {
        ...baseSession,
        id: 'session-active-stale-metadata',
        status: 'active',
        createdAt: 0,
        updatedAt: 500,
        sealedAt: undefined,
      },
      {
        ...baseSession,
        id: 'session-sealing-stale-metadata',
        status: 'sealing',
        createdAt: 0,
        updatedAt: 500,
        sealedAt: undefined,
      },
      {
        ...baseSession,
        id: 'session-sealed-before-window',
        createdAt: 0,
        updatedAt: 500,
        sealedAt: 500,
      },
    ];
    const scanned = [];
    const provider = new TrajectoryInspectorSourceProviderImpl({
      threadStore: { list: async () => [{ id: 'thread-owner' }] },
      sessionChainStore: { getChainByThread: async () => sessions },
      transcriptReader: {
        scanEvents: async (sessionId, _threadId, _catId, visitor) => {
          scanned.push(sessionId);
          await visitor(
            envelope(1, `inv-${sessionId}`, 1_200, { type: 'error', errorCode: 'provider_failed' }, { sessionId }),
          );
          return { present: true, eventCount: 1 };
        },
      },
      canonicalResolver: async (input) => ({
        status: 200,
        body: { invocationId: input.invocationId, threadId: input.threadIdHint, sessionId: input.sessionIdHint },
      }),
      externalEvidenceSource: noExternalEvidence,
    });

    const bundle = await provider.resolve(
      { kind: 'trajectory-inspector-window', windowStartMs: 900, windowEndMs: 2_000 },
      { ownerUserId: 'owner' },
    );

    assert.deepEqual(scanned.sort(), [
      'session-active-stale-metadata',
      'session-active-stale-metadata',
      'session-sealed-before-window',
      'session-sealing-stale-metadata',
      'session-sealing-stale-metadata',
    ]);
    assert.deepEqual(bundle.episodes.map((episode) => episode.invocationId).sort(), [
      'inv-session-active-stale-metadata',
      'inv-session-sealing-stale-metadata',
    ]);
  });

  it('selectively scans a historical session targeted by an in-window F192 finding', async () => {
    const historicalSession = {
      ...baseSession,
      id: 'session-historical-finding',
      threadId: 'thread-historical-finding',
      createdAt: 0,
      updatedAt: 500,
      sealedAt: 500,
    };
    const windowSession = {
      ...baseSession,
      id: 'session-window',
      threadId: 'thread-window',
    };
    const sessionsByThread = new Map([
      [historicalSession.threadId, [historicalSession]],
      [windowSession.threadId, [windowSession]],
    ]);
    const scanned = [];
    const candidateId = 'inv-historical-finding';
    const provider = new TrajectoryInspectorSourceProviderImpl({
      threadStore: { list: async () => [...sessionsByThread.keys()].map((id) => ({ id })) },
      sessionChainStore: { getChainByThread: async (threadId) => sessionsByThread.get(threadId) ?? [] },
      transcriptReader: {
        scanEvents: async (sessionId, threadId, _catId, visitor) => {
          scanned.push(sessionId);
          if (sessionId === historicalSession.id) {
            await visitor(
              envelope(1, candidateId, 400, { type: 'request_generation_prepared' }, { threadId, sessionId }),
            );
          }
          return { present: true, eventCount: sessionId === historicalSession.id ? 1 : 0 };
        },
      },
      candidateLocator: async () => ({ threadId: historicalSession.threadId, catId: historicalSession.catId }),
      canonicalResolver: async (input) => {
        const evidence = input.invocationEventsBySession?.get(historicalSession.id) ?? [];
        return evidence.some((event) => event.invocationId === candidateId)
          ? {
              status: 200,
              body: {
                invocationId: candidateId,
                threadId: historicalSession.threadId,
                sessionId: historicalSession.id,
              },
            }
          : { status: 404, body: { code: 'INVOCATION_SESSION_NOT_FOUND' } };
      },
      externalEvidenceSource: {
        ...noExternalEvidence,
        listFindings: async () => [
          { invocationId: candidateId, foundAtMs: 1_200, sourceRefs: ['snapshot:f192-historical'] },
        ],
      },
    });

    const bundle = await provider.resolve(
      { kind: 'trajectory-inspector-window', windowStartMs: 900, windowEndMs: 2_000 },
      { ownerUserId: 'owner' },
    );

    assert.deepEqual(scanned.sort(), [historicalSession.id, windowSession.id, windowSession.id].sort());
    assert.equal(bundle.episodes[0].evidenceOutcome, 'not_taken');
  });

  it('streams a large transcript and passes bounded candidate evidence to canonical resolution', async () => {
    const candidateId = 'inv-large-terminal';
    const eventCount = 250_000;
    let scanCount = 0;
    let canonicalInput;
    const provider = new TrajectoryInspectorSourceProviderImpl({
      threadStore: { list: async () => [{ id: 'thread-owner' }] },
      sessionChainStore: { getChainByThread: async () => [baseSession] },
      transcriptReader: {
        readAllEvents: async () => {
          throw new Error('unbounded readAllEvents must not be reachable');
        },
        scanEvents: async (_sessionId, _threadId, _catId, visitor) => {
          scanCount += 1;
          for (let index = 0; index < eventCount; index += 1) {
            await visitor(
              envelope(index, undefined, 1_000 + (index % 500), {
                type: 'status',
                content: 'x'.repeat(4_096),
              }),
            );
          }
          await visitor(envelope(eventCount, candidateId, 1_600, { type: 'error', errorCode: 'provider_failed' }));
          return { present: true, eventCount: eventCount + 1 };
        },
      },
      canonicalResolver: async (input) => {
        canonicalInput = input;
        return {
          status: 200,
          body: { invocationId: input.invocationId, threadId: 'thread-owner', sessionId: 'session-owner' },
        };
      },
      externalEvidenceSource: noExternalEvidence,
    });

    const bundle = await provider.resolve(
      { kind: 'trajectory-inspector-window', windowStartMs: 900, windowEndMs: 2_000 },
      { ownerUserId: 'owner' },
    );

    assert.deepEqual(
      bundle.episodes.map((episode) => episode.invocationId),
      [candidateId],
    );
    assert.equal(scanCount, 2, 'one discovery scan plus one candidate-evidence scan');
    assert.ok(canonicalInput.invocationEventsBySession instanceof Map);
    assert.equal(canonicalInput.invocationEventsBySession.get('session-owner').length, 1);
  });

  it('marks an unscoped F192 candidate scan as authoritative even when transcript evidence is absent', async () => {
    let canonicalInput;
    const provider = new TrajectoryInspectorSourceProviderImpl({
      threadStore: { list: async () => [{ id: 'thread-owner' }] },
      sessionChainStore: { getChainByThread: async () => [baseSession] },
      transcriptReader: {
        scanEvents: async () => ({ present: true, eventCount: 0 }),
      },
      canonicalResolver: async (input) => {
        canonicalInput = input;
        return { status: 404, body: { code: 'INVOCATION_SESSION_NOT_FOUND' } };
      },
      externalEvidenceSource: {
        ...noExternalEvidence,
        listFindings: async () => [
          { invocationId: 'inv-f192-only', foundAtMs: 1_200, sourceRefs: ['snapshot:f192-only'] },
        ],
      },
    });

    await provider.resolve(
      { kind: 'trajectory-inspector-window', windowStartMs: 900, windowEndMs: 2_000 },
      { ownerUserId: 'owner' },
    );

    assert.ok(canonicalInput.invocationEventsBySession instanceof Map);
    assert.equal(canonicalInput.invocationEventsBySession.size, 0);
  });

  it('fails closed when one candidate exceeds the retained evidence budget', async () => {
    const candidateId = 'inv-over-budget';
    const provider = new TrajectoryInspectorSourceProviderImpl({
      threadStore: { list: async () => [{ id: 'thread-owner' }] },
      sessionChainStore: { getChainByThread: async () => [baseSession] },
      transcriptReader: {
        scanEvents: async (_sessionId, _threadId, _catId, visitor) => {
          for (let index = 0; index < 101; index += 1) {
            await visitor(envelope(index, candidateId, 1_000 + index, { type: 'request_generation_prepared' }));
          }
          await visitor(envelope(101, candidateId, 1_500, { type: 'error', errorCode: 'provider_failed' }));
          return { present: true, eventCount: 102 };
        },
      },
      canonicalResolver: async () => ({ status: 404, body: { code: 'UNREACHABLE' } }),
      externalEvidenceSource: noExternalEvidence,
    });

    await assert.rejects(
      provider.resolve(
        { kind: 'trajectory-inspector-window', windowStartMs: 900, windowEndMs: 2_000 },
        { ownerUserId: 'owner' },
      ),
      /trajectory_inspector_candidate_evidence_budget_exceeded/,
    );
  });

  it('fails closed instead of truncating an oversized fallback command', async () => {
    const candidateId = 'inv-command-suffix';
    const provider = new TrajectoryInspectorSourceProviderImpl({
      threadStore: { list: async () => [{ id: 'thread-owner' }] },
      sessionChainStore: { getChainByThread: async () => [baseSession] },
      transcriptReader: {
        scanEvents: async (_sessionId, _threadId, _catId, visitor) => {
          await visitor(envelope(1, candidateId, 1_200, { type: 'error', errorCode: 'provider_failed' }));
          await visitor(
            envelope(2, 'investigator', 1_300, {
              type: 'tool_use',
              toolName: 'command_execution',
              toolUseId: 'oversized-fallback',
              toolInput: { command: `rg events.jsonl ${'x'.repeat(16_384)} ${candidateId}` },
            }),
          );
          return { present: true, eventCount: 2 };
        },
      },
      canonicalResolver: async (input) => ({
        status: 200,
        body: { invocationId: input.invocationId, threadId: 'thread-owner', sessionId: 'session-owner' },
      }),
      externalEvidenceSource: noExternalEvidence,
    });

    await assert.rejects(
      provider.resolve(
        { kind: 'trajectory-inspector-window', windowStartMs: 900, windowEndMs: 2_000 },
        { ownerUserId: 'owner' },
      ),
      /trajectory_inspector_fallback_command_budget_exceeded/,
    );
  });

  it('stops opening later transcript batches when the global candidate budget is exceeded', async () => {
    const sessions = Array.from({ length: 4 }, (_, index) => ({
      ...baseSession,
      id: `session-budget-${index}`,
      threadId: `thread-budget-${index}`,
      seq: index,
    }));
    const sessionsByThread = new Map(sessions.map((record) => [record.threadId, [record]]));
    const scanned = [];
    const provider = new TrajectoryInspectorSourceProviderImpl({
      threadStore: { list: async () => sessions.map((record) => ({ id: record.threadId })) },
      sessionChainStore: { getChainByThread: async (threadId) => sessionsByThread.get(threadId) ?? [] },
      transcriptReader: {
        scanEvents: async (sessionId, threadId, _catId, visitor) => {
          scanned.push(sessionId);
          for (let index = 0; index < 6_000; index += 1) {
            await visitor(
              envelope(
                index,
                `inv-${sessionId}-${index}`,
                1_200,
                { type: 'error', errorCode: 'provider_failed' },
                {
                  threadId,
                  sessionId,
                },
              ),
            );
          }
          return { present: true, eventCount: 6_000 };
        },
      },
      canonicalResolver: async () => ({ status: 404, body: { code: 'UNREACHABLE' } }),
      externalEvidenceSource: noExternalEvidence,
    });

    await assert.rejects(
      provider.resolve(
        { kind: 'trajectory-inspector-window', windowStartMs: 900, windowEndMs: 2_000 },
        { ownerUserId: 'owner' },
      ),
      /trajectory_inspector_candidate_budget_exceeded/,
    );
    assert.equal(scanned.length, 2, 'candidate rows must be merged before another scan batch opens');
  });
});
