import assert from 'node:assert/strict';
import { it } from 'node:test';
import { z } from 'zod';
import { publishVerdictInputSchema } from '../dist/tools/publish-verdict-tool.js';

const schema = z.object(publishVerdictInputSchema);
const source = {
  kind: 'designated-a2a-evaluator',
  checkoutHeadSha: 'a'.repeat(40),
  snapshotSha256: 'b'.repeat(64),
  attributionSha256: 'c'.repeat(64),
};
const input = {
  domainId: 'eval:a2a',
  packet: {
    id: 'test',
    domainId: 'eval:a2a',
    createdAt: '2026-06-05T11:00:00.000Z',
    phenomenon: 'test',
    verdict: 'keep_observe',
  },
  sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml', source },
};

it('preserves the designated evaluator pins through the actual MCP input schema', () => {
  assert.deepEqual(schema.parse(input).sourceRefs.source, source);
});

it('rejects arbitrary directories and missing/invalid evaluator pins before transport', () => {
  for (const invalid of [
    { ...source, path: '/tmp' },
    { ...source, checkoutHeadSha: '../main' },
    {
      ...source,
      snapshotSha256: 'bad',
    },
    { kind: source.kind },
  ]) {
    assert.equal(schema.safeParse({ ...input, sourceRefs: { ...input.sourceRefs, source: invalid } }).success, false);
  }
});
