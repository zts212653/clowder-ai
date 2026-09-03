import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F293 RoutingContextReadService', () => {
  test('loads catalog, ledgers and resolver once into one canonical read model', async () => {
    const { RoutingContextReadService } = await import('../dist/domains/routing-context/RoutingContextReadService.js');
    const calls = [];
    const service = new RoutingContextReadService({
      catalogSource: {
        async load() {
          calls.push('catalog');
          return {
            catalogRevision: 'catalog:v1',
            candidates: [{ v: 1, catId: 'fable5', providerId: 'anthropic', provenQuotaPools: [] }],
          };
        },
      },
      resolver: {
        async resolveWithSources(input) {
          calls.push(`resolver:${input.catalogRevision}:${input.candidates[0].catId}`);
          return {
            resolution: {
              status: 'fresh',
              snapshot: {
                v: 1,
                ownerId: input.ownerId,
                observedAt: input.observedAt,
                catalogRevision: input.catalogRevision,
                candidates: [],
              },
              inputRevisionRef: 'sha256:input',
              sourceRefs: { signalEventIds: [], preferenceRevisionIds: [], dossierRevisions: [] },
            },
            signalEvents: [],
            preferenceRevisions: [],
          };
        },
      },
    });
    const model = await service.read({ ownerId: 'owner-1', observedAt: 1_000, targetCatIds: ['fable5'] });
    assert.equal(model.resolution.state, 'fresh');
    assert.equal(model.catalogRevision, 'catalog:v1');
    assert.deepEqual(calls, ['catalog', 'resolver:catalog:v1:fable5']);
  });

  test('keeps canonical catalog membership visible when routing resolution is degraded', async () => {
    const { RoutingContextReadService } = await import('../dist/domains/routing-context/RoutingContextReadService.js');
    const candidates = [
      { v: 1, catId: 'fable5', providerId: 'anthropic', provenQuotaPools: [] },
      { v: 1, catId: 'glm52', providerId: 'zhipu', provenQuotaPools: [] },
    ];
    const service = new RoutingContextReadService({
      catalogSource: {
        async load() {
          return { catalogRevision: 'catalog:v2', candidates };
        },
      },
      resolver: {
        async resolveWithSources() {
          return {
            resolution: {
              status: 'degraded',
              reason: 'built_in_profile_missing',
              affectedCatIds: ['glm52'],
            },
            signalEvents: [],
            preferenceRevisions: [],
          };
        },
      },
    });

    const model = await service.read({ ownerId: 'owner-1', observedAt: 2_000 });

    assert.equal(model.resolution.state, 'degraded');
    assert.deepEqual(model.resolution.candidateBindings, candidates);
  });

  test('bounds presentation ledgers without changing the resolver snapshot', async () => {
    const { RoutingContextReadService } = await import('../dist/domains/routing-context/RoutingContextReadService.js');
    const events = Array.from({ length: 10_001 }, (_, index) => ({
      v: 1,
      eventId: `signal-${index}`,
      commandId: `command-${index}`,
      ownerId: 'owner-1',
      subjectRef: { type: 'cat', catId: 'fable5' },
      reasonCode: 'baseline',
      source: 'manual_cvo',
      observedAt: index + 1,
      evidenceRef: `message:${index}`,
      eventType: 'asserted',
      state: 'scarce',
      validUntil: 20_000 + index,
    }));
    const service = new RoutingContextReadService({
      catalogSource: {
        async load() {
          return { catalogRevision: 'catalog:v1', candidates: [] };
        },
      },
      resolver: {
        async resolveWithSources(input) {
          return {
            resolution: {
              status: 'fresh',
              snapshot: {
                v: 1,
                ownerId: input.ownerId,
                observedAt: input.observedAt,
                catalogRevision: input.catalogRevision,
                candidates: [],
              },
              inputRevisionRef: 'sha256:input',
              sourceRefs: {
                signalEventIds: events.map((event) => event.eventId),
                preferenceRevisionIds: [],
                dossierRevisions: [],
              },
            },
            signalEvents: events,
            preferenceRevisions: [],
          };
        },
      },
    });

    const model = await service.read({ ownerId: 'owner-1', observedAt: 15_000 });
    assert.equal(model.signalEvents.length, 10_000);
    assert.equal(model.resolution.sourceRefs.signalEventIds.length, 10_000);
    assert.equal(model.signalEvents[0].eventId, 'signal-1');
  });
});
