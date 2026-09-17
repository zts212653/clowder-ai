import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

function scheduleRegistrationBlock() {
  const start = source.indexOf('await app.register(scheduleRoutes, {');
  const end = source.indexOf('const { scheduleProposalDecisionRoutes }', start);
  assert.notEqual(start, -1, 'production bootstrap must register scheduleRoutes');
  assert.notEqual(end, -1, 'schedule route registration must precede proposal decision routes');
  return source.slice(start, end);
}

describe('F314 production schedule owner wiring', () => {
  it('carries the configured owner through the Approval-backed proposal creation seam', () => {
    const registration = scheduleRegistrationBlock();

    for (const requiredPort of ['ownerUserId: privateUserId', 'scheduleMutationProposalStore', 'approvalIngress']) {
      assert.ok(
        registration.includes(requiredPort),
        `production schedule registration must pass ${requiredPort} into proposal creation`,
      );
    }
  });
});
