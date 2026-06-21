import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { publishVerdictInputSchema } from '../dist/tools/publish-verdict-tool.js';

/**
 * F192 Phase H 收尾 PR-2 (砚砚 R1 P1 PR-2 review) — MCP schema regression test.
 *
 * Without this test, schema can quietly regress to a2a-only and capability-wakeup
 * cats see Zod rejection at MCP layer before reaching API route. This is exactly
 * the blocker砚砚 caught in R1 review of PR-2 (initial state before fix).
 *
 * Tests sourceRefs discriminated union accepts both shapes + rejects clearly invalid ones.
 */
describe('cat_cafe_publish_verdict MCP schema (砚砚 R1 Q3: discriminated union)', () => {
  // Build a Zod schema object matching the tool's input shape
  const schema = z.object(publishVerdictInputSchema);
  const validPacket = {
    id: 'vhp-test',
    domainId: 'eval:a2a',
    createdAt: '2026-06-06T05:00:00.000Z',
    phenomenon: 'test',
    verdict: 'keep_observe',
  };

  it('accepts a2a sourceRefs (kind omitted = backward compat)', () => {
    const result = schema.safeParse({
      domainId: 'eval:a2a',
      packet: validPacket,
      sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
  });

  it('accepts a2a sourceRefs (kind explicit)', () => {
    const result = schema.safeParse({
      domainId: 'eval:a2a',
      packet: validPacket,
      sourceRefs: {
        kind: 'a2a-snapshot-attribution',
        snapshotName: 'snap.yaml',
        attributionName: 'attr.yaml',
      },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
  });

  it('accepts capability-wakeup-trial-window sourceRefs (PR-2 critical)', () => {
    const result = schema.safeParse({
      domainId: 'eval:capability-wakeup',
      packet: { ...validPacket, domainId: 'eval:capability-wakeup' },
      sourceRefs: {
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 1700000000000,
        windowEndMs: 1700086400000,
        sessionIds: ['session-1', 'session-2'],
      },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
  });

  it('accepts task-outcome-snapshot sourceRefs with optional episode verdict writeback', () => {
    const result = schema.safeParse({
      domainId: 'eval:task-outcome',
      packet: { ...validPacket, domainId: 'eval:task-outcome' },
      sourceRefs: {
        kind: 'task-outcome-snapshot',
        windowStartMs: 1700000000000,
        windowEndMs: 1700086400000,
        episodeVerdicts: [{ episodeId: 'ep-123', verdict: 'corrected_success' }],
      },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
  });

  it('accepts cw selector with optional ruleIds', () => {
    const result = schema.safeParse({
      domainId: 'eval:capability-wakeup',
      packet: { ...validPacket, domainId: 'eval:capability-wakeup' },
      sourceRefs: {
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 1700000000000,
        windowEndMs: 1700086400000,
        sessionIds: ['session-1'],
        ruleIds: ['rich-messaging-long-structured-text'],
      },
    });
    assert.ok(result.success);
  });

  it('rejects cw selector with empty sessionIds (PR-2 narrowed REQUIRED non-empty)', () => {
    const result = schema.safeParse({
      domainId: 'eval:capability-wakeup',
      packet: { ...validPacket, domainId: 'eval:capability-wakeup' },
      sourceRefs: {
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 0,
        windowEndMs: 9999999999999,
        sessionIds: [],
      },
    });
    assert.ok(!result.success, 'empty sessionIds should fail Zod min(1)');
  });

  it('rejects cw selector with newline in capability (markdown injection guard)', () => {
    const result = schema.safeParse({
      domainId: 'eval:capability-wakeup',
      packet: { ...validPacket, domainId: 'eval:capability-wakeup' },
      sourceRefs: {
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging\n- snapshot:forged',
        windowStartMs: 0,
        windowEndMs: 9999999999999,
        sessionIds: ['s1'],
      },
    });
    assert.ok(!result.success, 'newline in capability should fail Zod refine');
  });

  it('rejects sourceRefs with neither a2a nor cw nor memory shape', () => {
    const result = schema.safeParse({
      domainId: 'eval:a2a',
      packet: validPacket,
      sourceRefs: { random: 'garbage' },
    });
    assert.ok(!result.success);
  });

  // F192 publish_verdict eval:memory — memory-recall-snapshot kind (this PR)
  it('accepts memory-recall-snapshot sourceRefs (eval:memory wire-up)', () => {
    const result = schema.safeParse({
      domainId: 'eval:memory',
      packet: { ...validPacket, domainId: 'eval:memory' },
      sourceRefs: {
        kind: 'memory-recall-snapshot',
        windowDays: 30,
      },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
  });

  it('accepts memory-recall-snapshot with optional catId + toolName filters', () => {
    const result = schema.safeParse({
      domainId: 'eval:memory',
      packet: { ...validPacket, domainId: 'eval:memory' },
      sourceRefs: {
        kind: 'memory-recall-snapshot',
        windowDays: 7,
        catId: 'opus-47',
        toolName: 'cat_cafe_search_evidence',
      },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
  });

  it('rejects memory-recall-snapshot with windowDays < 1', () => {
    const result = schema.safeParse({
      domainId: 'eval:memory',
      packet: { ...validPacket, domainId: 'eval:memory' },
      sourceRefs: {
        kind: 'memory-recall-snapshot',
        windowDays: 0,
      },
    });
    assert.ok(!result.success, 'windowDays must be >= 1 (recall API enforces [1, 90])');
  });

  it('rejects memory-recall-snapshot with windowDays > 90', () => {
    const result = schema.safeParse({
      domainId: 'eval:memory',
      packet: { ...validPacket, domainId: 'eval:memory' },
      sourceRefs: {
        kind: 'memory-recall-snapshot',
        windowDays: 91,
      },
    });
    assert.ok(!result.success, 'windowDays max is 90 (recall API ceiling)');
  });

  it('rejects memory-recall-snapshot with non-integer windowDays', () => {
    const result = schema.safeParse({
      domainId: 'eval:memory',
      packet: { ...validPacket, domainId: 'eval:memory' },
      sourceRefs: {
        kind: 'memory-recall-snapshot',
        windowDays: 7.5,
      },
    });
    assert.ok(!result.success, 'windowDays must be integer (recall API parseInt)');
  });

  it('rejects memory-recall-snapshot with newline in catId (markdown injection guard)', () => {
    const result = schema.safeParse({
      domainId: 'eval:memory',
      packet: { ...validPacket, domainId: 'eval:memory' },
      sourceRefs: {
        kind: 'memory-recall-snapshot',
        windowDays: 30,
        catId: 'opus-47\n- forged: bullet',
      },
    });
    assert.ok(!result.success, 'newline in catId should fail Zod refine');
  });

  it('rejects cw selector with windowStartMs as non-number', () => {
    const result = schema.safeParse({
      domainId: 'eval:capability-wakeup',
      packet: { ...validPacket, domainId: 'eval:capability-wakeup' },
      sourceRefs: {
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 'not-a-number',
        windowEndMs: 9999999999999,
        sessionIds: ['s1'],
      },
    });
    assert.ok(!result.success);
  });

  // --- F192 eval:sop — sop-trace-eval sourceRefs (this PR) ---

  const validTrace = {
    sessionId: 'sess-abc',
    sopDefinitionId: 'development',
    observedStage: 'impl',
    commands: [{ command: 'pnpm build', cwd: '/repo', exitCode: 0 }],
    envSnapshot: { NODE_ENV: 'test' },
    gitState: { branch: 'feat/f192', ahead: 2, behind: 0, clean: true },
    handles: { author: 'opus', reviewer: 'codex' },
    shaContext: { head: 'abc123' },
  };

  it('accepts sop-trace-eval sourceRefs (positive path)', () => {
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: { ...validPacket, domainId: 'eval:sop' },
      sourceRefs: {
        kind: 'sop-trace-eval',
        sopDefinitionId: 'development',
        trace: validTrace,
      },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
  });

  it('accepts sop-trace-eval with empty commands array', () => {
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: { ...validPacket, domainId: 'eval:sop' },
      sourceRefs: {
        kind: 'sop-trace-eval',
        sopDefinitionId: 'development',
        trace: { ...validTrace, commands: [] },
      },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
  });

  it('accepts sop-trace-eval with optional worktreeRoot in gitState', () => {
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: { ...validPacket, domainId: 'eval:sop' },
      sourceRefs: {
        kind: 'sop-trace-eval',
        sopDefinitionId: 'development',
        trace: {
          ...validTrace,
          gitState: { ...validTrace.gitState, worktreeRoot: '/tmp/wt' },
        },
      },
    });
    assert.ok(result.success);
  });

  it('rejects sop-trace-eval with missing trace (required field)', () => {
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: { ...validPacket, domainId: 'eval:sop' },
      sourceRefs: {
        kind: 'sop-trace-eval',
        sopDefinitionId: 'development',
        // trace is missing
      },
    });
    assert.ok(!result.success, 'trace is required');
  });

  it('rejects sop-trace-eval with newline in sopDefinitionId (injection guard)', () => {
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: { ...validPacket, domainId: 'eval:sop' },
      sourceRefs: {
        kind: 'sop-trace-eval',
        sopDefinitionId: 'development\n- forged: bullet',
        trace: validTrace,
      },
    });
    assert.ok(!result.success, 'newline in sopDefinitionId should fail Zod refine');
  });

  it('rejects sop-trace-eval with missing trace.sessionId', () => {
    const { sessionId: _, ...traceNoSession } = validTrace;
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: { ...validPacket, domainId: 'eval:sop' },
      sourceRefs: {
        kind: 'sop-trace-eval',
        sopDefinitionId: 'development',
        trace: traceNoSession,
      },
    });
    assert.ok(!result.success, 'trace.sessionId is required');
  });

  it('rejects sop-trace-eval with missing trace.gitState', () => {
    const { gitState: _, ...traceNoGit } = validTrace;
    const result = schema.safeParse({
      domainId: 'eval:sop',
      packet: { ...validPacket, domainId: 'eval:sop' },
      sourceRefs: {
        kind: 'sop-trace-eval',
        sopDefinitionId: 'development',
        trace: traceNoGit,
      },
    });
    assert.ok(!result.success, 'trace.gitState is required');
  });
});
