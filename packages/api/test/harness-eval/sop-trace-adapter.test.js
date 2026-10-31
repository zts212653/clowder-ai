import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSopTrace } from '../../dist/infrastructure/harness-eval/sop/sop-trace-adapter.js';

const validInput = {
  sessionId: 'session-001',
  sopDefinitionId: 'development',
  observedStage: 'merge',
  commands: [
    { command: 'pnpm gate', exitCode: 0 },
    { command: 'gh pr merge 1913 --squash --delete-branch', cwd: '/home/user/cat-cafe', exitCode: 0 },
  ],
  changedFiles: [],
  envSnapshot: {
    REDIS_URL: 'redis://localhost:6398',
    NODE_ENV: undefined,
  },
  gitState: {
    branch: 'main',
    ahead: 0,
    behind: 0,
    clean: true,
    worktreeRoot: '/home/user/cat-cafe',
  },
  handles: {
    author: 'opus',
    reviewer: 'gpt52',
    guardian: 'opus47',
  },
  shaContext: {
    cloud_review: 'abc123def',
  },
};

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const ROUTE_PATH = 'packages/api/src/routes/thread-invocations.ts';

function validDesignGateEvidence() {
  return {
    changedFiles: [ROUTE_PATH],
    diffContext: {
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      files: [{ path: ROUTE_PATH, addedLines: ['resolveThreadAccessPolicy(request)'] }],
    },
    designGateReviewPacket: {
      exactHeadSha: HEAD_SHA,
      riskClaims: [
        {
          id: 'consumer-thread-invocations',
          kind: 'consumer_delta',
          summary: 'New route reuses canonical access policy.',
          canonicalSource: 'packages/api/src/domains/thread-access-policy.ts#resolveThreadAccessPolicy',
          consumerEvidence: `rg -n "resolveThreadAccessPolicy" ${ROUTE_PATH}`,
          claimGuard: {
            command: 'node --test packages/api/test/thread-invocations-route.test.js',
            redWhen: 'the route rejects an indexed system thread',
          },
        },
      ],
      targetedSelfCheckReceipts: [
        {
          claimId: 'consumer-thread-invocations',
          headSha: HEAD_SHA,
          command: 'node --test packages/api/test/thread-invocations-route.test.js',
          exitCode: 0,
        },
      ],
    },
  };
}

describe('SOP Trace Adapter (AC-E17)', () => {
  it('builds a valid SopTrace from structured input', () => {
    const trace = buildSopTrace(validInput);

    assert.equal(trace.sessionId, 'session-001');
    assert.equal(trace.sopDefinitionId, 'development');
    assert.equal(trace.observedStage, 'merge');
    assert.equal(trace.commands.length, 2);
    assert.equal(trace.commands[0].command, 'pnpm gate');
    assert.equal(trace.envSnapshot.REDIS_URL, 'redis://localhost:6398');
    assert.equal(trace.gitState.ahead, 0);
    assert.equal(trace.handles.author, 'opus');
    assert.equal(trace.shaContext.cloud_review, 'abc123def');
  });

  it('accepts empty commands array', () => {
    const trace = buildSopTrace({ ...validInput, commands: [] });
    assert.equal(trace.commands.length, 0);
  });

  it('preserves command stdout and parsed summary for replayable evidence', () => {
    const trace = buildSopTrace({
      ...validInput,
      commands: [
        {
          command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool',
          exitCode: 0,
          eventNo: 4,
          timestamp: 1700000004000,
          stdout: JSON.stringify({ freshness: { stale: false } }),
          summary: { freshness: { stale: false } },
        },
      ],
      changedFileEvents: [{ path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 5 }],
    });

    assert.equal(trace.commands[0].stdout, JSON.stringify({ freshness: { stale: false } }));
    assert.deepEqual(trace.commands[0].summary, { freshness: { stale: false } });
    assert.equal(trace.commands[0].eventNo, 4);
    assert.equal(trace.commands[0].timestamp, 1700000004000);
    assert.deepEqual(trace.changedFileEvents, [
      { path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 5 },
    ]);
  });

  it('rejects missing changedFiles instead of defaulting to a silent clean set', () => {
    const { changedFiles: _changedFiles, ...missingChangedFiles } = validInput;
    assert.throws(() => buildSopTrace(missingChangedFiles), /changedFiles/);
  });

  it('rejects changedFileEvents without ordering evidence', () => {
    assert.throws(
      () =>
        buildSopTrace({
          ...validInput,
          changedFileEvents: [{ path: 'packages/mcp-server/src/tools/callback-tools.ts' }],
        }),
      /eventNo|timestamp/,
    );
  });

  it('rejects convention graph command ordering that cannot be compared to changedFileEvents', () => {
    assert.throws(
      () =>
        buildSopTrace({
          ...validInput,
          commands: [
            {
              command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool',
              exitCode: 0,
              timestamp: 1700000004000,
            },
          ],
          changedFileEvents: [{ path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 5 }],
        }),
      /shared eventNo or timestamp/,
    );
  });

  it('accepts changedFileEvents when no convention graph command is present', () => {
    const trace = buildSopTrace({
      ...validInput,
      commands: [{ command: 'pnpm test', exitCode: 0 }],
      changedFileEvents: [{ path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 5 }],
    });
    assert.equal(trace.changedFileEvents[0].eventNo, 5);
  });

  it('accepts empty shaContext', () => {
    const trace = buildSopTrace({ ...validInput, shaContext: {} });
    assert.deepEqual(trace.shaContext, {});
  });

  it('preserves undefined env values', () => {
    const trace = buildSopTrace({
      ...validInput,
      envSnapshot: { REDIS_URL: 'redis://localhost:6398', MISSING_VAR: undefined },
    });
    assert.equal(trace.envSnapshot.MISSING_VAR, undefined);
    assert.equal(trace.envSnapshot.REDIS_URL, 'redis://localhost:6398');
  });

  it('preserves exact diff context and the structured design-gate review packet', () => {
    const evidence = validDesignGateEvidence();
    const trace = buildSopTrace({ ...validInput, ...evidence });

    assert.deepEqual(trace.diffContext, evidence.diffContext);
    assert.deepEqual(trace.designGateReviewPacket, evidence.designGateReviewPacket);
  });

  it('rejects diff context that does not cover the exact changed-file set', () => {
    const evidence = validDesignGateEvidence();
    assert.throws(
      () =>
        buildSopTrace({
          ...validInput,
          ...evidence,
          changedFiles: [ROUTE_PATH, 'packages/api/src/routes/second-route.ts'],
        }),
      /same path set|diffContext/i,
    );
  });

  it('rejects duplicate risk claim ids', () => {
    const evidence = validDesignGateEvidence();
    assert.throws(
      () =>
        buildSopTrace({
          ...validInput,
          ...evidence,
          designGateReviewPacket: {
            ...evidence.designGateReviewPacket,
            riskClaims: [evidence.designGateReviewPacket.riskClaims[0], evidence.designGateReviewPacket.riskClaims[0]],
          },
        }),
      /risk claim ids.*unique/i,
    );
  });

  it('rejects a review packet that is not bound to the diff exact HEAD', () => {
    const evidence = validDesignGateEvidence();
    assert.throws(
      () =>
        buildSopTrace({
          ...validInput,
          ...evidence,
          designGateReviewPacket: {
            ...evidence.designGateReviewPacket,
            exactHeadSha: 'c'.repeat(40),
          },
        }),
      /exactHeadSha.*headSha|exact HEAD/i,
    );
  });

  it('rejects a review packet without exact diff context', () => {
    const evidence = validDesignGateEvidence();
    assert.throws(
      () =>
        buildSopTrace({
          ...validInput,
          changedFiles: [ROUTE_PATH],
          designGateReviewPacket: evidence.designGateReviewPacket,
        }),
      /requires diffContext exact HEAD/i,
    );
  });

  it('rejects abbreviated Git SHAs in diff context', () => {
    const evidence = validDesignGateEvidence();
    assert.throws(
      () =>
        buildSopTrace({
          ...validInput,
          ...evidence,
          diffContext: { ...evidence.diffContext, headSha: 'abc123' },
        }),
      /40-character Git SHA/i,
    );
  });

  it('rejects missing sessionId', () => {
    assert.throws(() => buildSopTrace({ ...validInput, sessionId: '' }));
  });

  it('rejects missing sopDefinitionId', () => {
    assert.throws(() => buildSopTrace({ ...validInput, sopDefinitionId: '' }));
  });

  it('rejects negative git ahead count', () => {
    assert.throws(() =>
      buildSopTrace({
        ...validInput,
        gitState: { ...validInput.gitState, ahead: -1 },
      }),
    );
  });
});
