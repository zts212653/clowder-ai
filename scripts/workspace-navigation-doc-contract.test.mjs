import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const F223_PATH = resolve('docs/features/F223-capability-surface-registry.md');

test('F223 current Workspace trace preserves legacy delivery and dedicated ack truth', () => {
  const featureDoc = readFileSync(F223_PATH, 'utf8');
  const traceStart = featureDoc.indexOf('MCP `cat_cafe_workspace_navigate`');
  const traceEnd = featureDoc.indexOf('**结论：代码层愿景对齐 PASS。**', traceStart);

  assert.notEqual(traceStart, -1, 'F223 must retain the current Workspace execution trace');
  assert.notEqual(traceEnd, -1, 'F223 Workspace trace must end at the current vision-guard conclusion');

  const trace = featureDoc.slice(traceStart, traceEnd);
  const legacyEmitIndex = trace.indexOf('`socketEmit`');
  const ackEmitIndex = trace.indexOf('`socketEmitWithAck`');

  assert.notEqual(legacyEmitIndex, -1, 'trace must name the legacy socketEmit delivery branch');
  assert.match(trace, /`worktree:\*`/);
  assert.match(trace, /`workspace:global`/);
  assert.notEqual(ackEmitIndex, -1, 'trace must name the acknowledged delivery branch');
  assert.match(trace, /`workspace:navigate:ack`/);
  assert.ok(legacyEmitIndex < ackEmitIndex, 'legacy compatibility delivery must precede acknowledgement collection');
  assert.match(trace, /legacy 广播不参与\s+`deliveryStatus`/);
});
