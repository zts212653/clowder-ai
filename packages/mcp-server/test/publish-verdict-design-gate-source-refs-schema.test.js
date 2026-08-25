import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { publishVerdictInputSchema } from '../dist/tools/publish-verdict-tool.js';

describe('cat_cafe_publish_verdict eval:design-gate sourceRefs schema', () => {
  const schema = z.object(publishVerdictInputSchema);
  const packet = {
    id: 'f303-design-gate-observe',
    domainId: 'eval:design-gate',
    createdAt: '2026-08-23T17:00:00.000Z',
    phenomenon: 'Observation window remains open.',
    verdict: 'keep_observe',
  };

  it('accepts a bounded server-owned source map id', () => {
    const result = schema.safeParse({
      domainId: 'eval:design-gate',
      packet,
      sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId: 'f303-phase-c-pr3901' },
    });
    assert.ok(result.success, JSON.stringify(result));
    assert.equal(result.data.sourceRefs.sourceMapId, 'f303-phase-c-pr3901');
  });

  it('rejects paths and caller-supplied episode facts', () => {
    for (const sourceRefs of [
      { kind: 'design-gate-episode-source-map', sourceMapId: '../f303-phase-c-pr3901' },
      {
        kind: 'design-gate-episode-source-map',
        sourceMapId: 'f303-phase-c-pr3901',
        exactHeadSha: 'a'.repeat(40),
      },
    ]) {
      const result = schema.safeParse({ domainId: 'eval:design-gate', packet, sourceRefs });
      assert.equal(result.success, false);
    }
  });
});
