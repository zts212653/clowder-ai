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

  // F245 Phase C PR1b — friction-rollup-snapshot kind (this PR)
  it('accepts friction-rollup-snapshot sourceRefs (eval:friction wire-up)', () => {
    const result = schema.safeParse({
      domainId: 'eval:friction',
      packet: { ...validPacket, domainId: 'eval:friction' },
      sourceRefs: {
        kind: 'friction-rollup-snapshot',
        windowStartMs: 1700000000000,
        windowEndMs: 1700086400000,
      },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
  });

  it('accepts friction-rollup-snapshot with optional topN + tokenCap', () => {
    const result = schema.safeParse({
      domainId: 'eval:friction',
      packet: { ...validPacket, domainId: 'eval:friction' },
      sourceRefs: {
        kind: 'friction-rollup-snapshot',
        windowStartMs: 1700000000000,
        windowEndMs: 1700086400000,
        topN: 5,
        tokenCap: 2000,
      },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
  });

  it('rejects friction-rollup-snapshot with non-finite windowStartMs', () => {
    const result = schema.safeParse({
      domainId: 'eval:friction',
      packet: { ...validPacket, domainId: 'eval:friction' },
      sourceRefs: {
        kind: 'friction-rollup-snapshot',
        windowStartMs: 'not-a-number',
        windowEndMs: 1700086400000,
      },
    });
    assert.ok(!result.success, 'non-finite windowStartMs should fail');
  });

  it('rejects friction-rollup-snapshot with non-integer topN', () => {
    const result = schema.safeParse({
      domainId: 'eval:friction',
      packet: { ...validPacket, domainId: 'eval:friction' },
      sourceRefs: {
        kind: 'friction-rollup-snapshot',
        windowStartMs: 1700000000000,
        windowEndMs: 1700086400000,
        topN: 2.5,
      },
    });
    assert.ok(!result.success, 'non-integer topN should fail Zod int()');
  });

  // F253 Phase C — qc-metrics-rollup kind (砚砚 R1 review blocker: same-class
  // regression without test coverage)
  it('accepts qc-metrics-rollup sourceRefs (eval:qc wire-up)', () => {
    const result = schema.safeParse({
      domainId: 'eval:qc',
      packet: { ...validPacket, domainId: 'eval:qc' },
      sourceRefs: {
        kind: 'qc-metrics-rollup',
        windowStartMs: 1759276800000,
        windowEndMs: 1759363200000,
      },
    });
    assert.ok(result.success, `expected accept, got: ${JSON.stringify(result)}`);
  });

  it('rejects qc-metrics-rollup with non-finite windowStartMs', () => {
    const result = schema.safeParse({
      domainId: 'eval:qc',
      packet: { ...validPacket, domainId: 'eval:qc' },
      sourceRefs: {
        kind: 'qc-metrics-rollup',
        windowStartMs: Number.POSITIVE_INFINITY,
        windowEndMs: 1759363200000,
      },
    });
    assert.ok(!result.success, 'non-finite windowStartMs should fail Zod finite()');
  });

  it('rejects qc-metrics-rollup with non-number windowEndMs', () => {
    const result = schema.safeParse({
      domainId: 'eval:qc',
      packet: { ...validPacket, domainId: 'eval:qc' },
      sourceRefs: {
        kind: 'qc-metrics-rollup',
        windowStartMs: 1759276800000,
        windowEndMs: 'not-a-number',
      },
    });
    assert.ok(!result.success, 'non-number windowEndMs should fail Zod number()');
  });

  it('rejects qc-metrics-rollup with missing windowStartMs', () => {
    const result = schema.safeParse({
      domainId: 'eval:qc',
      packet: { ...validPacket, domainId: 'eval:qc' },
      sourceRefs: {
        kind: 'qc-metrics-rollup',
        windowEndMs: 1759363200000,
      },
    });
    assert.ok(!result.success, 'missing windowStartMs should fail Zod required');
  });

  it('rejects caller-selected freshness fixture ids because coverage is server-owned', () => {
    const result = schema.safeParse({
      domainId: 'eval:freshness',
      packet: { ...validPacket, domainId: 'eval:freshness' },
      sourceRefs: {
        kind: 'freshness-closure-replay',
        windowStartMs: 1700000000000,
        windowEndMs: 1700086400000,
        threadIds: ['thread-f254'],
        fixtureIds: ['original-double-message-dogfood', 'connector-blocked'],
      },
    });
    assert.ok(!result.success, 'fixtureIds must not be part of the caller-facing selector contract');
  });

  it('rejects caller-invented freshness fixture ids', () => {
    const result = schema.safeParse({
      domainId: 'eval:freshness',
      packet: { ...validPacket, domainId: 'eval:freshness' },
      sourceRefs: {
        kind: 'freshness-closure-replay',
        windowStartMs: 1700000000000,
        windowEndMs: 1700086400000,
        fixtureIds: ['caller-authored-metrics'],
      },
    });
    assert.ok(!result.success);
  });
});
