import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { publishVerdictInputSchema } from '../dist/tools/publish-verdict-tool.js';

describe('cat_cafe_publish_verdict eval:sop sourceRefs schema', () => {
  const schema = z.object(publishVerdictInputSchema);
  const validPacket = {
    id: 'vhp-sop-test',
    domainId: 'eval:sop',
    createdAt: '2026-06-06T05:00:00.000Z',
    phenomenon: 'test',
    verdict: 'keep_observe',
  };

  it('accepts sop-trace-eval sourceRefs and preserves changedFiles', () => {
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: validPacket,
      sourceRefs: {
        kind: 'sop-trace-eval',
        sopDefinitionId: 'development',
        trace: {
          sessionId: 'sess-test-123',
          sopDefinitionId: 'development',
          observedStage: 'worktree',
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
          changedFiles: [],
          changedFileEvents: [{ path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 5 }],
          envSnapshot: { REDIS_URL: 'redis://localhost:6398' },
          gitState: { branch: 'feat/test', ahead: 0, behind: 0, clean: true },
          handles: { author: 'opus', reviewer: 'codex' },
          shaContext: {},
        },
      },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
    assert.deepEqual(result.data.sourceRefs.trace.changedFiles, [], 'schema must preserve changedFiles');
    assert.equal(
      result.data.sourceRefs.trace.commands[0].stdout,
      JSON.stringify({ freshness: { stale: false } }),
      'schema must preserve command stdout for freshness replay',
    );
    assert.deepEqual(
      result.data.sourceRefs.trace.commands[0].summary,
      { freshness: { stale: false } },
      'schema must preserve parsed command summary for freshness replay',
    );
    assert.equal(result.data.sourceRefs.trace.commands[0].eventNo, 4, 'schema must preserve command event order');
    assert.equal(result.data.sourceRefs.trace.commands[0].timestamp, 1700000004000);
    assert.deepEqual(
      result.data.sourceRefs.trace.changedFileEvents,
      [{ path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 5 }],
      'schema must preserve changed-file order evidence',
    );
  });

  it('accepts sop-trace-eval with optional trace fields', () => {
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: validPacket,
      sourceRefs: {
        kind: 'sop-trace-eval',
        sopDefinitionId: 'development',
        trace: {
          sessionId: 'sess-456',
          sopDefinitionId: 'development',
          observedStage: 'review',
          commands: [],
          changedFiles: ['cat-cafe-skills/convention-graph-discovery/SKILL.md'],
          envSnapshot: {},
          gitState: { branch: 'feat/review', ahead: 1, behind: 0, clean: false, worktreeRoot: '/tmp/worktree' },
          handles: { author: 'opus', reviewer: 'gpt52', guardian: 'sonnet' },
          shaContext: { prSha: 'abc123' },
        },
      },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
  });

  it('preserves exact diff context and design-gate review evidence', () => {
    const trace = baseTrace();
    const routePath = 'packages/api/src/routes/thread-invocations.ts';
    const headSha = 'b'.repeat(40);
    trace.changedFiles = [routePath];
    trace.diffContext = {
      baseSha: 'a'.repeat(40),
      headSha,
      files: [{ path: routePath, addedLines: ['resolveThreadAccessPolicy(request)'] }],
    };
    trace.designGateReviewPacket = {
      exactHeadSha: headSha,
      riskClaims: [
        {
          id: 'consumer-thread-invocations',
          kind: 'consumer_delta',
          summary: 'New route reuses canonical access policy.',
          canonicalSource: 'packages/api/src/domains/thread-access-policy.ts#resolveThreadAccessPolicy',
          consumerEvidence: `rg -n "resolveThreadAccessPolicy" ${routePath}`,
          claimGuard: {
            command: 'node --test packages/api/test/thread-invocations-route.test.js',
            redWhen: 'the route rejects an indexed system thread',
          },
        },
      ],
      targetedSelfCheckReceipts: [
        {
          claimId: 'consumer-thread-invocations',
          headSha,
          command: 'node --test packages/api/test/thread-invocations-route.test.js',
          exitCode: 0,
        },
      ],
    };

    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: validPacket,
      sourceRefs: { kind: 'sop-trace-eval', sopDefinitionId: 'development', trace },
    });

    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
    assert.deepEqual(result.data.sourceRefs.trace.diffContext, trace.diffContext);
    assert.deepEqual(result.data.sourceRefs.trace.designGateReviewPacket, trace.designGateReviewPacket);
  });

  it('rejects a design-gate review packet whose HEAD differs from the diff HEAD', () => {
    const trace = baseTrace();
    trace.changedFiles = ['packages/api/src/routes/thread-invocations.ts'];
    trace.diffContext = {
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      files: [{ path: trace.changedFiles[0], addedLines: ['resolveThreadAccessPolicy(request)'] }],
    };
    trace.designGateReviewPacket = {
      exactHeadSha: 'c'.repeat(40),
      riskClaims: [],
      targetedSelfCheckReceipts: [],
    };

    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: validPacket,
      sourceRefs: { kind: 'sop-trace-eval', sopDefinitionId: 'development', trace },
    });

    assert.ok(!result.success, 'mismatched exact HEAD must fail closed at the MCP contract');
  });

  it('rejects abbreviated Git SHAs in design-gate diff context', () => {
    const trace = baseTrace();
    trace.changedFiles = ['packages/api/src/routes/thread-invocations.ts'];
    trace.diffContext = {
      baseSha: 'a'.repeat(40),
      headSha: 'abc123',
      files: [{ path: trace.changedFiles[0], addedLines: [] }],
    };

    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: validPacket,
      sourceRefs: { kind: 'sop-trace-eval', sopDefinitionId: 'development', trace },
    });

    assert.ok(!result.success, 'abbreviated HEAD must fail closed at the MCP contract');
  });

  it('rejects sop-trace-eval with missing changedFiles', () => {
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: validPacket,
      sourceRefs: {
        kind: 'sop-trace-eval',
        sopDefinitionId: 'development',
        trace: {
          sessionId: 'sess-test',
          sopDefinitionId: 'development',
          observedStage: 'worktree',
          commands: [],
          envSnapshot: {},
          gitState: { branch: 'main', ahead: 0, behind: 0, clean: true },
          handles: {},
          shaContext: {},
        },
      },
    });
    assert.ok(!result.success, 'missing changedFiles must fail closed');
  });

  it('rejects sop-trace-eval changedFileEvents without eventNo or timestamp', () => {
    const trace = baseTrace();
    trace.changedFileEvents = [{ path: 'packages/mcp-server/src/tools/callback-tools.ts' }];
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: validPacket,
      sourceRefs: { kind: 'sop-trace-eval', sopDefinitionId: 'development', trace },
    });
    assert.ok(!result.success, 'changedFileEvents without ordering evidence must fail closed');
  });

  it('rejects sop-trace-eval convention graph commands without shared ordering coordinates', () => {
    const trace = baseTrace();
    trace.commands = [
      {
        command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool',
        exitCode: 0,
        timestamp: 1700000004000,
      },
    ];
    trace.changedFileEvents = [{ path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 5 }];
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: validPacket,
      sourceRefs: { kind: 'sop-trace-eval', sopDefinitionId: 'development', trace },
    });
    assert.ok(!result.success, 'mixed timestamp/eventNo ordering must fail closed before SOP replay');
  });

  it('accepts sop-trace-eval changedFileEvents when no convention graph command is present', () => {
    const trace = baseTrace();
    trace.commands = [{ command: 'pnpm test', exitCode: 0 }];
    trace.changedFileEvents = [{ path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 5 }];
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: validPacket,
      sourceRefs: { kind: 'sop-trace-eval', sopDefinitionId: 'development', trace },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
  });

  it('rejects sop-trace-eval with empty sopDefinitionId', () => {
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: validPacket,
      sourceRefs: {
        kind: 'sop-trace-eval',
        sopDefinitionId: '',
        trace: baseTrace(),
      },
    });
    assert.ok(!result.success, 'empty sopDefinitionId should fail min(1)');
  });

  it('rejects sop-trace-eval with missing trace', () => {
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: validPacket,
      sourceRefs: { kind: 'sop-trace-eval', sopDefinitionId: 'development' },
    });
    assert.ok(!result.success, 'missing trace should fail');
  });

  it('rejects sop-trace-eval with missing gitState.branch', () => {
    const trace = baseTrace();
    delete trace.gitState.branch;
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: validPacket,
      sourceRefs: { kind: 'sop-trace-eval', sopDefinitionId: 'development', trace },
    });
    assert.ok(!result.success, 'missing gitState.branch should fail min(1)');
  });
});

function baseTrace() {
  return {
    sessionId: 'sess-test',
    sopDefinitionId: 'development',
    observedStage: 'worktree',
    commands: [],
    changedFiles: [],
    envSnapshot: {},
    gitState: { branch: 'main', ahead: 0, behind: 0, clean: true },
    handles: {},
    shaContext: {},
  };
}
