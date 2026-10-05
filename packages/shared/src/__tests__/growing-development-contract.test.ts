import { describe, expect, it } from 'vitest';
import { entrustedWorkV1Schema } from '../types/growing.js';

const scope = {
  featureRef: 'feature:F310',
  phaseKey: 'B',
  workUnitRef: 'feature-phase:F310:B',
  acceptedSourceRef: 'file:docs/features/F310-growing-real-delegation.md',
  acceptedRevision: 'a'.repeat(40),
};
const work = {
  revision: 1,
  admission: {
    basis: 'explicit_entrustment',
    sourceRefs: ['message:source'],
    idempotencyKey: 'source',
    receiptRef: 'task:receipt:source',
    admittedAt: 1,
  },
  intendedOutcome: 'Continue the accepted development outcome',
  time: {},
  artifactRefs: [],
  closure: {
    condition: 'Accepted result is verified',
    expectedSignal: 'accepted-result',
    state: 'open',
    evidenceRefs: [],
  },
};

describe('F310 durable development scope', () => {
  it('round-trips stable scope and lineage without changing original admission or adding time', () => {
    const value = { ...work, developmentScope: scope, parentTaskRef: 'task:work:parent' };
    const parsed = entrustedWorkV1Schema.safeParse(value);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(value);
  });
  it('keeps media and research custody compatible without a Feature scope', () => {
    expect(entrustedWorkV1Schema.safeParse(work).success).toBe(true);
  });
  it.each([
    'my phase',
    'message:new-message',
    'feature-phase:F311:B',
    'feature-phase:F310:C',
    'file:docs/plans/../secrets.md#unit',
    'file:docs/plans/plan.md',
  ])('rejects invalid work-unit ref %s', (workUnitRef) => {
    expect(entrustedWorkV1Schema.safeParse({ ...work, developmentScope: { ...scope, workUnitRef } }).success).toBe(
      false,
    );
  });
});
