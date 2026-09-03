import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { reduceRoutingContext } = await import('../dist/domains/routing-context/routing-context-reducer.js');

function candidate(catId) {
  return {
    v: 1,
    catId,
    providerId: 'openai',
    provenQuotaPools: [],
  };
}

function duplicateAssertion(index) {
  const eventId = `signal:duplicate:${String(index).padStart(2, '0')}`;
  return {
    v: 1,
    eventId,
    commandId: `command:${eventId}`,
    ownerId: 'owner-1',
    subjectRef: { type: 'cat', catId: 'sol' },
    reasonCode: 'provider_unreachable',
    note: 'Provider probe could not reach the exact cat route.',
    source: 'health_probe',
    observedAt: 1_000,
    evidenceRef: `evidence:${eventId}`,
    eventType: 'asserted',
    state: 'unavailable',
    validUntil: 20_000,
  };
}

describe('F293 automatic signal projection noise control', () => {
  it('coalesces equivalent assertions while preserving bounded source refs', () => {
    const snapshot = reduceRoutingContext({
      ownerId: 'owner-1',
      observedAt: 10_000,
      catalogRevision: 'catalog:v1',
      candidates: [candidate('sol')],
      profiles: [],
      signalEvents: Array.from({ length: 20 }, (_, index) => duplicateAssertion(index)),
      preferenceRevisions: [],
    });

    const [sol] = snapshot.candidates;
    assert.equal(sol.availability, 'unavailable');
    assert.equal(sol.reasons.length, 1);
    assert.equal(sol.reasons[0].sourceRefs.length, 32);
    assert.deepEqual(sol.reasons[0].sourceRefs.slice(0, 4), [
      'signal:duplicate:00',
      'evidence:signal:duplicate:00',
      'signal:duplicate:01',
      'evidence:signal:duplicate:01',
    ]);
  });
});
