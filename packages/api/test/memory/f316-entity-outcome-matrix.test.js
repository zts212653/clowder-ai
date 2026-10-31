import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('F316 relationship vertical — Entity outcome matrix', () => {
  let db;
  let registry;

  const entity = (overrides = {}) => ({
    entityId: 'person:river-a',
    type: 'person',
    canonicalName: 'River A',
    aliases: ['River', 'Shared Name'],
    provenance: [{ source: 'proposal', anchor: 'ep-river-a' }],
    stance: 'unknown',
    visibilityScope: 'workspace',
    status: 'active',
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    ...overrides,
  });

  beforeEach(async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { EntityRegistryStore } = await import('../../dist/domains/memory/EntityRegistry.js');
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
    registry = new EntityRegistryStore(db);
  });

  it('returns revision-bound not_available, resolved, and ambiguous outcomes from the real registry', () => {
    const absent = registry.resolveExactAliasOutcome('Shared Name', 'owner-1');
    assert.equal(absent.status, 'not_available');
    assert.match(absent.registryRevision, /^sha256:[a-f0-9]{64}$/);

    registry.upsert([entity()], { source: 'proposal-approval', proposalId: 'ep-river-a' });
    const resolved = registry.resolveExactAliasOutcome('Shared Name', 'owner-1');
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.match.entityId, 'person:river-a');
    assert.match(resolved.match.sourceRevision, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(resolved.registryRevision, absent.registryRevision);

    registry.upsert(
      [
        entity({
          entityId: 'person:river-b',
          canonicalName: 'River B',
          aliases: ['Shared Name'],
          provenance: [{ source: 'proposal', anchor: 'ep-river-b' }],
        }),
      ],
      { source: 'proposal-approval', proposalId: 'ep-river-b' },
    );
    const ambiguous = registry.resolveExactAliasOutcome('Shared Name', 'owner-1');
    assert.equal(ambiguous.status, 'ambiguous');
    assert.deepEqual(
      ambiguous.matches.map((match) => match.entityId),
      ['person:river-a', 'person:river-b'],
    );
    assert.equal(new Set(ambiguous.matches.map((match) => match.sourceRevision)).size, 2);
    assert.notEqual(ambiguous.registryRevision, resolved.registryRevision);
  });

  it('changes exact revisions after correction and makes retirement unavailable', () => {
    registry.upsert([entity()], { source: 'proposal-approval', proposalId: 'ep-river-a' });
    const before = registry.resolveExactAliasOutcome('River', 'owner-1');
    assert.equal(before.status, 'resolved');

    registry.upsert(
      [
        entity({
          canonicalName: 'River A Corrected',
          provenance: [{ source: 'proposal', anchor: 'ep-river-a-corrected' }],
          updatedAt: '2026-09-04T01:00:00.000Z',
        }),
      ],
      { source: 'proposal-approval', proposalId: 'ep-river-a-corrected', reason: 'explicit correction' },
    );
    const corrected = registry.resolveExactAliasOutcome('River', 'owner-1');
    assert.equal(corrected.status, 'resolved');
    assert.notEqual(corrected.match.sourceRevision, before.match.sourceRevision);
    assert.notEqual(corrected.registryRevision, before.registryRevision);

    registry.upsert(
      [
        entity({
          canonicalName: 'River A Corrected',
          provenance: [{ source: 'proposal', anchor: 'ep-river-a-retired' }],
          status: 'retired',
          updatedAt: '2026-09-04T02:00:00.000Z',
        }),
      ],
      { source: 'proposal-approval', proposalId: 'ep-river-a-retired', reason: 'explicit retirement' },
    );
    const retired = registry.resolveExactAliasOutcome('River', 'owner-1');
    assert.equal(retired.status, 'not_available');
    assert.notEqual(retired.registryRevision, corrected.registryRevision);
  });

  it('does not turn a same-name doc title into a Person cue without a registered identity root', async () => {
    db.prepare(
      `INSERT INTO evidence_docs
       (anchor, kind, status, title, summary, keywords, source_path, updated_at, provenance_tier)
       VALUES (?, 'architecture', 'active', ?, '', '', ?, ?, 'primary')`,
    ).run('doc:atlas-notes', 'Atlas Notes', 'docs/atlas-notes.md', '2026-09-04T00:00:00.000Z');
    const { mirrorDocAliases } = await import('../../dist/domains/memory/doc-alias-mirror.js');
    const { InputEntityDetector } = await import('../../dist/domains/memory/InputEntityDetector.js');
    const { EntityNudgeBuilder } = await import('../../dist/domains/memory/EntityNudgeBuilder.js');
    const { subjectSeenCueSeeds } = await import('../../dist/domains/cats/services/agents/routing/route-helpers.js');
    mirrorDocAliases(db);

    const detector = new InputEntityDetector(db);
    const builder = new EntityNudgeBuilder();
    const docOnly = detector.detect('Atlas Notes', { ownerUserId: 'owner-1' });
    assert.equal(docOnly[0].sourceTable, 'doc_aliases');
    assert.equal(docOnly[0].type, 'doc');
    assert.equal(docOnly[0].entityId, undefined);
    assert.deepEqual(
      subjectSeenCueSeeds({
        result: { nudges: builder.build(docOnly) },
        sourceMessageId: 'message-doc-title',
        occurredAt: 1,
      }),
      [],
    );

    registry.upsert(
      [
        entity({
          entityId: 'person:atlas',
          canonicalName: 'Atlas Notes',
          aliases: ['Atlas Notes'],
          provenance: [{ source: 'proposal', anchor: 'ep-atlas' }],
        }),
      ],
      { source: 'proposal-approval', proposalId: 'ep-atlas' },
    );
    const registered = detector.detect('Atlas Notes', { ownerUserId: 'owner-1' });
    assert.equal(registered[0].sourceTable, 'entity_registry');
    assert.match(registered[0].sourceRevision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(builder.build(registered)[0].sourceRevision, registered[0].sourceRevision);
    const seeds = subjectSeenCueSeeds({
      result: { nudges: builder.build(registered) },
      sourceMessageId: 'message-registered-person',
      occurredAt: 2,
    });
    assert.equal(seeds.length, 1);
    assert.equal(seeds[0].payload.entityId, 'person:atlas');
    assert.equal(seeds[0].payload.sourceRevision, registered[0].sourceRevision);
  });

  it('fails closed before Person recall when a queued Entity revision is corrected or retired', async () => {
    const { InputEntityDetector } = await import('../../dist/domains/memory/InputEntityDetector.js');
    const { EntityNudgeBuilder } = await import('../../dist/domains/memory/EntityNudgeBuilder.js');
    const { subjectSeenCueSeeds } = await import('../../dist/domains/cats/services/agents/routing/route-helpers.js');
    const { PersonEntityCueResolver } = await import(
      '../../dist/domains/memory/cue/resolvers/PersonEntityCueResolver.js'
    );

    registry.upsert([entity()], { source: 'proposal-approval', proposalId: 'ep-river-a' });
    const detector = new InputEntityDetector(db);
    const builder = new EntityNudgeBuilder();
    const seedFor = (sourceMessageId, occurredAt) => {
      const detected = detector.detect('River', { ownerUserId: 'owner-1' });
      const seeds = subjectSeenCueSeeds({
        result: { nudges: builder.build(detected) },
        sourceMessageId,
        occurredAt,
      });
      assert.equal(seeds.length, 1);
      return seeds[0];
    };
    const opportunityFor = (seed, opportunityId) => ({
      ...seed,
      v: 1,
      opportunityId,
      consumer: 'agent_route',
      scope: {
        ownerUserId: 'owner-1',
        threadId: 'thread-current',
        invocationId: 'invocation-current',
      },
    });
    let personRecallCount = 0;
    const resolver = new PersonEntityCueResolver(
      {
        async resolve() {
          personRecallCount += 1;
          return {
            title: 'River',
            summary: 'Owner-private relationship memory is available.',
            anchor: 'person-memory:river',
            revision: 'sha256:person-card-v1',
            asOf: 1,
            visibility: 'owner_private',
            drillFamily: 'person_memory',
          };
        },
      },
      registry,
    );
    const context = {
      now: 2,
      expiresAt: 60_002,
      consumerCatId: 'codex-sol',
      createDrillHandle: () => 'drill-handle',
    };

    const originalSeed = seedFor('message-before-correction', 1);
    assert.equal((await resolver.resolve(opportunityFor(originalSeed, 'opportunity-current'), context)).length, 1);
    assert.equal(personRecallCount, 1);

    registry.upsert(
      [
        entity({
          canonicalName: 'River A Corrected',
          provenance: [{ source: 'proposal', anchor: 'ep-river-a-corrected' }],
          updatedAt: '2026-09-04T01:00:00.000Z',
        }),
      ],
      { source: 'proposal-approval', proposalId: 'ep-river-a-corrected', reason: 'explicit correction' },
    );
    assert.deepEqual(await resolver.resolve(opportunityFor(originalSeed, 'opportunity-stale-correction'), context), []);
    assert.equal(personRecallCount, 1, 'stale correction must stop before owner-private Person recall');

    const correctedSeed = seedFor('message-before-retirement', 3);
    registry.upsert(
      [
        entity({
          canonicalName: 'River A Corrected',
          provenance: [{ source: 'proposal', anchor: 'ep-river-a-retired' }],
          status: 'retired',
          updatedAt: '2026-09-04T02:00:00.000Z',
        }),
      ],
      { source: 'proposal-approval', proposalId: 'ep-river-a-retired', reason: 'explicit retirement' },
    );
    assert.deepEqual(
      await resolver.resolve(opportunityFor(correctedSeed, 'opportunity-stale-retirement'), context),
      [],
    );
    assert.equal(personRecallCount, 1, 'stale retirement must stop before owner-private Person recall');
  });

  it('keeps an outsider empty snapshot stable across private create, correction, and retirement', () => {
    const alias = 'Private River';
    const outsiderBefore = registry.resolveExactAliasOutcome(alias, 'outsider');
    assert.equal(outsiderBefore.status, 'not_available');

    registry.upsert([entity({ aliases: [alias], visibilityScope: 'private:owner-1' })], {
      source: 'proposal-approval',
      proposalId: 'ep-private-river',
    });
    const outsiderCreated = registry.resolveExactAliasOutcome(alias, 'outsider');
    const ownerCreated = registry.resolveExactAliasOutcome(alias, 'owner-1');
    assert.equal(outsiderCreated.status, 'not_available');
    assert.equal(ownerCreated.status, 'resolved');
    assert.equal(outsiderCreated.registryRevision, outsiderBefore.registryRevision);

    registry.upsert(
      [
        entity({
          aliases: [alias],
          canonicalName: 'Private River Corrected',
          visibilityScope: 'private:owner-1',
          provenance: [{ source: 'proposal', anchor: 'ep-private-river-corrected' }],
          updatedAt: '2026-09-04T01:00:00.000Z',
        }),
      ],
      { source: 'proposal-approval', proposalId: 'ep-private-river-corrected', reason: 'explicit correction' },
    );
    const outsiderCorrected = registry.resolveExactAliasOutcome(alias, 'outsider');
    const ownerCorrected = registry.resolveExactAliasOutcome(alias, 'owner-1');
    assert.equal(outsiderCorrected.status, 'not_available');
    assert.equal(ownerCorrected.status, 'resolved');
    assert.equal(outsiderCorrected.registryRevision, outsiderBefore.registryRevision);
    assert.notEqual(ownerCorrected.registryRevision, ownerCreated.registryRevision);

    registry.upsert(
      [
        entity({
          aliases: [alias],
          canonicalName: 'Private River Corrected',
          visibilityScope: 'private:owner-1',
          provenance: [{ source: 'proposal', anchor: 'ep-private-river-retired' }],
          status: 'retired',
          updatedAt: '2026-09-04T02:00:00.000Z',
        }),
      ],
      { source: 'proposal-approval', proposalId: 'ep-private-river-retired', reason: 'explicit retirement' },
    );
    const outsiderRetired = registry.resolveExactAliasOutcome(alias, 'outsider');
    const ownerRetired = registry.resolveExactAliasOutcome(alias, 'owner-1');
    assert.equal(outsiderRetired.status, 'not_available');
    assert.equal(ownerRetired.status, 'not_available');
    assert.equal(outsiderRetired.registryRevision, outsiderBefore.registryRevision);
    assert.notEqual(ownerRetired.registryRevision, ownerCorrected.registryRevision);
  });
});
