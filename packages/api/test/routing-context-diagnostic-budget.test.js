import assert from 'node:assert/strict';
import { it } from 'node:test';

const { reduceRoutingContext } = await import('../dist/domains/routing-context/routing-context-reducer.js');

it('keeps dossier diagnostics with a full signal budget without turning capability context into a reason', () => {
  const events = Array.from({ length: 40 }, (_, index) => ({
    v: 1,
    eventId: `signal:budget:${index}`,
    commandId: `command:budget:${index}`,
    ownerId: 'owner-1',
    subjectRef: { type: 'cat', catId: 'sol' },
    reasonCode: `budget_${index}`,
    source: 'health_probe',
    observedAt: 1_000,
    evidenceRef: `evidence:budget:${index}`,
    eventType: 'asserted',
    state: 'scarce',
    validUntil: 20_000,
  }));
  const snapshot = reduceRoutingContext({
    ownerId: 'owner-1',
    observedAt: 10_000,
    catalogRevision: 'catalog:v1',
    candidates: [{ v: 1, catId: 'sol', providerId: 'openai', provenQuotaPools: [] }],
    profiles: [
      {
        v: 1,
        catId: 'sol',
        modelId: 'model:sol',
        dossierRevision: 'dossier:v1',
        updatedAt: 2_000,
        relevantSignals: [{ kind: 'strength', summary: 'Architecture', evidenceRefs: ['dossier:source'] }],
        pendingProposalCount: 0,
      },
    ],
    profileDiagnostics: [
      {
        catId: 'sol',
        reason: {
          code: 'capability_profile_invalid',
          summary: 'Dossier line 7 has invalid YAML',
          sourceRefs: ['docs/team/cat-dossier.md#L7'],
        },
      },
    ],
    signalEvents: events,
    preferenceRevisions: [],
  });
  const sol = snapshot.candidates[0];
  assert.equal(sol.reasons.length, 32);
  assert.equal(sol.reasons[0].code, 'capability_profile_invalid');
  assert.equal(sol.reasons.filter((reason) => reason.code === 'routing_signal_scarce').length, 31);
  assert.ok(sol.reasons.every((reason) => reason.code !== 'capability_strength'));
  assert.equal(sol.profile.revision.relevantSignals[0].kind, 'strength');
});
