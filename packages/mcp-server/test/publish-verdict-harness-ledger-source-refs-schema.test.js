import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { publishVerdictInputSchema } from '../dist/tools/publish-verdict-tool.js';

describe('cat_cafe_publish_verdict Harness Ledger sourceRefs schema', () => {
  const schema = z.object(publishVerdictInputSchema);
  const base = {
    domainId: 'eval:harness-ledger',
    packet: {
      id: 'hlr-1760086400000-deadbeef',
      domainId: 'eval:harness-ledger',
      createdAt: '2026-08-17T00:00:00.000Z',
      phenomenon: 'Harness Ledger snapshot evaluation',
      verdict: 'keep_observe',
    },
    sourceRefs: {
      kind: 'prompt-segments',
      windowStartMs: 1_760_000_000_000,
      windowEndMs: 1_760_086_400_000,
      evalRunId: 'hlr-1760086400000-deadbeef',
    },
  };

  it('accepts the exact frozen snapshot selector', () => {
    const result = schema.safeParse(base);
    assert.ok(result.success, JSON.stringify(result));
  });

  it('rejects a reversed snapshot window', () => {
    const result = schema.safeParse({
      ...base,
      sourceRefs: { ...base.sourceRefs, windowEndMs: base.sourceRefs.windowStartMs },
    });
    assert.equal(result.success, false);
  });

  it('rejects invented or traversal-capable evalRunId values', () => {
    for (const evalRunId of ['run-1', '../hlr-1760086400000-deadbeef', 'hlr-1760086400000-DEADBEEF']) {
      const result = schema.safeParse({ ...base, sourceRefs: { ...base.sourceRefs, evalRunId } });
      assert.equal(result.success, false, evalRunId);
    }
  });

  it('rejects newline-bearing optional guard identifiers', () => {
    const result = schema.safeParse({
      ...base,
      sourceRefs: { ...base.sourceRefs, guardId: 'hold-ball\nforged' },
    });
    assert.equal(result.success, false);
  });
});
