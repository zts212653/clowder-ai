import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { publishVerdictInputSchema } from '../dist/tools/publish-verdict-tool.js';

const schema = z.object(publishVerdictInputSchema);
const packet = {
  id: 'f299-trajectory-observe',
  domainId: 'eval:trajectory-inspector',
  createdAt: '2026-08-24T20:00:00.000Z',
  phenomenon: 'Calibration window.',
  verdict: 'keep_observe',
};

describe('cat_cafe_publish_verdict trajectory inspector selector schema', () => {
  it('accepts a bounded window-only selector', () => {
    const result = schema.safeParse({
      domainId: 'eval:trajectory-inspector',
      packet,
      sourceRefs: { kind: 'trajectory-inspector-window', windowStartMs: 1_000, windowEndMs: 2_000 },
    });
    assert.ok(result.success, JSON.stringify(result));
  });

  it('rejects reversed, oversized, non-finite, and caller-authored episode facts', () => {
    for (const sourceRefs of [
      { kind: 'trajectory-inspector-window', windowStartMs: 2_000, windowEndMs: 1_000 },
      { kind: 'trajectory-inspector-window', windowStartMs: 0, windowEndMs: 32 * 24 * 60 * 60 * 1_000 },
      { kind: 'trajectory-inspector-window', windowStartMs: 1_000, windowEndMs: Number.POSITIVE_INFINITY },
      { kind: 'trajectory-inspector-window', windowStartMs: 1_000, windowEndMs: 2_000, episodes: [] },
    ]) {
      assert.equal(schema.safeParse({ domainId: 'eval:trajectory-inspector', packet, sourceRefs }).success, false);
    }
  });
});
