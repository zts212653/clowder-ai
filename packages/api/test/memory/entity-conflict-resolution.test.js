import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('F260 entity conflict resolution', () => {
  let db;
  let registry;

  const entity = (overrides = {}) => ({
    entityId: 'concept:沉迷护栏',
    type: 'concept',
    canonicalName: '防AI沉迷护栏',
    aliases: ['沉迷护栏', '护栏喵'],
    provenance: [{ source: 'proposal', anchor: 'ep-old' }],
    stance: 'endorsed',
    visibilityScope: 'workspace',
    status: 'active',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
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

  it('projects a same-entity material update into an actionable before/after conflict', () => {
    registry.upsert([entity()], { source: 'system' });
    const conflict = registry.inspectConflict(
      entity({
        aliases: ['沉迷护栏', '护栏喵', '猫猫安全护栏', '安全护栏', 'AI沉迷护栏'],
        provenance: [{ source: 'proposal', anchor: 'ep-8' }],
        updatedAt: '2026-07-18T00:00:00.000Z',
      }),
    );

    assert.equal(conflict.reason, 'existing-entity-change');
    assert.equal(conflict.version, 1);
    assert.equal(conflict.incoming.entityId, 'concept:沉迷护栏');
    assert.deepEqual(
      conflict.candidates.map((candidate) => candidate.entityId),
      ['concept:沉迷护栏'],
    );
    assert.deepEqual(conflict.candidates[0].aliases, ['护栏喵', '沉迷护栏']);
    assert.deepEqual(conflict.allowedActions, ['merge-aliases', 'replace', 'reject']);
    assert.deepEqual(conflict.canonicalReplacementRequiredFor, []);
    assert.match(conflict.fingerprint, /^[a-f0-9]{64}$/);
  });

  it('projects a cross-entity surface collision with candidate records and exact surfaces', () => {
    registry.upsert([entity()], { source: 'system' });
    const conflict = registry.inspectConflict(
      entity({
        entityId: 'concept:ai-safety-guard',
        canonicalName: 'AI Safety Guard',
        aliases: ['  沉迷护栏  ', 'AI安全护栏'],
        provenance: [{ source: 'proposal', anchor: 'ep-new' }],
        updatedAt: '2026-07-18T00:00:00.000Z',
      }),
    );

    assert.equal(conflict.reason, 'surface-collision');
    assert.deepEqual(conflict.conflictingSurfaces, ['沉迷护栏']);
    assert.deepEqual(
      conflict.candidates.map((candidate) => candidate.entityId),
      ['concept:沉迷护栏'],
    );
    assert.equal(conflict.candidates[0].canonicalName, '防AI沉迷护栏');
    assert.deepEqual(conflict.allowedActions, ['correct', 'transfer', 'polysemy', 'reject']);
    assert.deepEqual(conflict.canonicalReplacementRequiredFor, []);
  });

  it('redacts private collision candidates from non-owners and fails closed to reject', () => {
    registry.upsert(
      [
        entity({
          entityId: 'concept:private-guard',
          canonicalName: 'Owner Secret Guard',
          aliases: ['shared-guard', 'owner-secret-alias'],
          visibilityScope: 'private:user-owner',
          updatedAt: '2026-07-18T12:34:56.000Z',
        }),
      ],
      { source: 'system' },
    );
    const incoming = entity({
      entityId: 'concept:workspace-guard',
      canonicalName: 'Workspace Guard',
      aliases: ['shared-guard'],
    });

    const redacted = registry.inspectConflict(incoming, 'user-other');
    assert.deepEqual(redacted.candidates, []);
    assert.deepEqual(redacted.allowedActions, ['reject']);
    assert.deepEqual(redacted.canonicalReplacementRequiredFor, []);
    assert.doesNotMatch(
      JSON.stringify(redacted),
      /Owner Secret Guard|owner-secret-alias|private:user-owner|2026-07-18T12:34:56/,
    );

    const ownerView = registry.inspectConflict(incoming, 'user-owner');
    assert.deepEqual(
      ownerView.candidates.map(({ entityId }) => entityId),
      ['concept:private-guard'],
    );
    assert.deepEqual(ownerView.allowedActions, ['correct', 'transfer', 'polysemy', 'reject']);
  });

  it('requires an explicit replacement when correction or transfer would move a canonical surface', () => {
    registry.upsert([entity()], { source: 'system' });
    const conflict = registry.inspectConflict(
      entity({
        entityId: 'concept:new-guard',
        canonicalName: 'New Guard',
        aliases: ['防AI沉迷护栏'],
      }),
    );

    assert.equal(conflict.reason, 'surface-collision');
    assert.deepEqual(conflict.canonicalReplacementRequiredFor, ['concept:沉迷护栏']);
  });

  it('returns null for a byte-equivalent proposal or a conflict-free new entity', () => {
    const current = entity();
    registry.upsert([current], { source: 'system' });

    assert.equal(registry.inspectConflict(current), null);
    assert.equal(
      registry.inspectConflict(
        entity({ entityId: 'concept:unrelated', canonicalName: 'Unrelated', aliases: ['unrelated'] }),
      ),
      null,
    );
  });

  it('changes the fingerprint when current registry truth changes', () => {
    registry.upsert([entity()], { source: 'system' });
    const incoming = entity({ aliases: ['沉迷护栏', 'AI沉迷护栏'] });
    const before = registry.inspectConflict(incoming);

    registry.upsert(
      [entity({ aliases: ['沉迷护栏', '护栏喵', '防沉迷小猫'], updatedAt: '2026-07-18T00:00:00.000Z' })],
      { source: 'system' },
    );
    const after = registry.inspectConflict(incoming);

    assert.notEqual(before.fingerprint, after.fingerprint);
  });

  it('merges aliases and provenance while preserving same-entity current fields', () => {
    registry.upsert([entity()], { source: 'system' });
    const incoming = entity({
      canonicalName: '猫猫安全护栏',
      aliases: ['安全护栏', 'AI沉迷护栏'],
      provenance: [{ source: 'proposal', anchor: 'ep-8' }],
      stance: 'unknown',
      updatedAt: '2026-07-18T00:00:00.000Z',
    });
    const conflict = registry.inspectConflict(incoming);

    registry.resolveConflict(
      incoming,
      { action: 'merge-aliases', fingerprint: conflict.fingerprint },
      { source: 'proposal-approval', actorId: 'you', proposalId: 'ep-8' },
    );

    const resolved = registry.get(incoming.entityId);
    assert.equal(resolved.canonicalName, '防AI沉迷护栏');
    assert.equal(resolved.stance, 'endorsed');
    assert.deepEqual(resolved.aliases, ['AI沉迷护栏', '安全护栏', '护栏喵', '沉迷护栏', '猫猫安全护栏']);
    assert.deepEqual(resolved.provenance, [
      { source: 'proposal', anchor: 'ep-old' },
      { source: 'proposal', anchor: 'ep-8' },
    ]);
    const revisions = db
      .prepare('SELECT operation, reason FROM entity_revision_events WHERE proposal_id = ?')
      .all('ep-8');
    assert.deepEqual(revisions, [{ operation: 'update', reason: 'conflict-resolution:merge-aliases' }]);
  });

  it('explicitly replaces a same-entity record and records its before/after revision', () => {
    registry.upsert([entity()], { source: 'system' });
    const incoming = entity({
      canonicalName: '猫猫安全护栏',
      aliases: ['安全护栏'],
      provenance: [{ source: 'proposal', anchor: 'ep-replace' }],
      stance: 'critique_target',
      updatedAt: '2026-07-18T00:00:00.000Z',
    });
    const conflict = registry.inspectConflict(incoming);

    registry.resolveConflict(
      incoming,
      { action: 'replace', fingerprint: conflict.fingerprint },
      { source: 'proposal-approval', actorId: 'you', proposalId: 'ep-replace' },
    );

    const resolved = registry.get(incoming.entityId);
    assert.equal(resolved.canonicalName, '猫猫安全护栏');
    assert.deepEqual(resolved.aliases, ['安全护栏']);
    assert.equal(resolved.stance, 'critique_target');
    const revision = db
      .prepare('SELECT before_json, after_json, reason FROM entity_revision_events WHERE proposal_id = ?')
      .get('ep-replace');
    assert.equal(JSON.parse(revision.before_json).canonicalName, '防AI沉迷护栏');
    assert.equal(JSON.parse(revision.after_json).canonicalName, '猫猫安全护栏');
    assert.equal(revision.reason, 'conflict-resolution:replace');
  });

  it('rejects a stale fingerprint and a same-entity merge that would steal a foreign surface', () => {
    registry.upsert(
      [
        entity(),
        entity({
          entityId: 'concept:foreign',
          canonicalName: 'Foreign Guard',
          aliases: ['AI沉迷护栏'],
        }),
      ],
      { source: 'system' },
    );
    const incoming = entity({ aliases: ['沉迷护栏', 'AI沉迷护栏'] });
    const conflict = registry.inspectConflict(incoming);

    assert.throws(
      () =>
        registry.resolveConflict(
          incoming,
          { action: 'merge-aliases', fingerprint: '0'.repeat(64) },
          { source: 'proposal-approval', proposalId: 'ep-stale' },
        ),
      (error) => error.code === 'ENTITY_CONFLICT_STALE',
    );
    assert.throws(
      () =>
        registry.resolveConflict(
          incoming,
          { action: 'merge-aliases', fingerprint: conflict.fingerprint },
          { source: 'proposal-approval', proposalId: 'ep-steal' },
        ),
      (error) => error.code === 'ENTITY_CONFLICT_INVALID_RESOLUTION',
    );
    assert.equal(registry.get('concept:foreign').aliases.includes('AI沉迷护栏'), true);
    assert.equal(registry.get(incoming.entityId).aliases.includes('AI沉迷护栏'), false);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM entity_revision_events WHERE proposal_id LIKE 'ep-%'").get().n,
      0,
    );
  });

  it('rejects a same-entity merge against a hidden private owner without identifying it', () => {
    const current = entity();
    registry.upsert(
      [
        current,
        entity({
          entityId: 'concept:private-foreign',
          canonicalName: 'Owner Secret Guard',
          aliases: ['owner-secret-alias'],
          visibilityScope: 'private:user-owner',
        }),
      ],
      { source: 'system' },
    );
    const before = registry.get(current.entityId);
    const incoming = entity({ aliases: ['沉迷护栏', 'owner-secret-alias'] });
    const conflict = registry.inspectConflict(incoming, 'user-other');

    assert.throws(
      () =>
        registry.resolveConflict(
          incoming,
          { action: 'merge-aliases', fingerprint: conflict.fingerprint },
          { source: 'proposal-approval', actorId: 'user-other', proposalId: 'ep-private-steal' },
        ),
      (error) => {
        assert.equal(error.code, 'ENTITY_CONFLICT_INVALID_RESOLUTION');
        assert.doesNotMatch(error.message, /concept:private-foreign|Owner Secret Guard|owner-secret-alias/);
        return true;
      },
    );
    assert.deepEqual(registry.get(current.entityId), before);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM entity_revision_events WHERE proposal_id = ?').get('ep-private-steal').n,
      0,
    );
  });

  it('corrects canonical and alias collisions atomically with explicit replacements', () => {
    registry.upsert(
      [
        entity(),
        entity({
          entityId: 'concept:second-guard',
          canonicalName: 'Second Guard',
          aliases: ['沉迷护栏', '第二护栏'],
        }),
      ],
      { source: 'system' },
    );
    const incoming = entity({
      entityId: 'concept:new-guard',
      canonicalName: 'New Guard',
      aliases: ['防AI沉迷护栏', '沉迷护栏'],
      provenance: [{ source: 'proposal', anchor: 'ep-correct' }],
    });
    const conflict = registry.inspectConflict(incoming);

    registry.resolveConflict(
      incoming,
      {
        action: 'correct',
        fingerprint: conflict.fingerprint,
        replacementCanonicalNames: { 'concept:沉迷护栏': '旧防沉迷护栏' },
      },
      { source: 'proposal-approval', actorId: 'you', proposalId: 'ep-correct' },
    );

    assert.equal(registry.get('concept:沉迷护栏').canonicalName, '旧防沉迷护栏');
    assert.equal(registry.get('concept:沉迷护栏').aliases.includes('沉迷护栏'), false);
    assert.equal(registry.get('concept:second-guard').aliases.includes('沉迷护栏'), false);
    assert.deepEqual(registry.get(incoming.entityId).aliases, ['沉迷护栏', '防AI沉迷护栏']);
    const revisions = db
      .prepare('SELECT entity_id, reason FROM entity_revision_events WHERE proposal_id = ? ORDER BY entity_id')
      .all('ep-correct');
    assert.deepEqual(revisions, [
      { entity_id: 'concept:new-guard', reason: 'conflict-resolution:correction' },
      { entity_id: 'concept:second-guard', reason: 'conflict-resolution:correction' },
      { entity_id: 'concept:沉迷护栏', reason: 'conflict-resolution:correction' },
    ]);
  });

  it('records transfer semantics while moving an alias surface', () => {
    registry.upsert([entity()], { source: 'system' });
    const incoming = entity({
      entityId: 'concept:transferred',
      canonicalName: 'Transferred Guard',
      aliases: ['沉迷护栏'],
    });
    const conflict = registry.inspectConflict(incoming);

    registry.resolveConflict(
      incoming,
      { action: 'transfer', fingerprint: conflict.fingerprint },
      { source: 'proposal-approval', proposalId: 'ep-transfer' },
    );

    assert.equal(registry.get('concept:沉迷护栏').aliases.includes('沉迷护栏'), false);
    assert.ok(registry.get(incoming.entityId));
    assert.deepEqual(
      db.prepare('SELECT DISTINCT reason FROM entity_revision_events WHERE proposal_id = ?').all('ep-transfer'),
      [{ reason: 'conflict-resolution:transfer' }],
    );
  });

  it('allows explicit polysemy without mutating existing candidates', () => {
    registry.upsert([entity()], { source: 'system' });
    const before = registry.get('concept:沉迷护栏');
    const incoming = entity({
      entityId: 'concept:polysemous',
      canonicalName: 'Polysemous Guard',
      aliases: ['沉迷护栏'],
    });
    const conflict = registry.inspectConflict(incoming);

    registry.resolveConflict(
      incoming,
      { action: 'polysemy', fingerprint: conflict.fingerprint },
      { source: 'proposal-approval', proposalId: 'ep-polysemy' },
    );

    assert.deepEqual(registry.get('concept:沉迷护栏'), before);
    assert.ok(registry.get(incoming.entityId));
    assert.deepEqual(
      db.prepare('SELECT entity_id, reason FROM entity_revision_events WHERE proposal_id = ?').all('ep-polysemy'),
      [{ entity_id: 'concept:polysemous', reason: 'conflict-resolution:polysemy' }],
    );
  });

  it('rejects missing or colliding canonical replacements with zero side effects', () => {
    registry.upsert([entity()], { source: 'system' });
    const before = registry.get('concept:沉迷护栏');
    const incoming = entity({
      entityId: 'concept:new-guard',
      canonicalName: 'New Guard',
      aliases: ['防AI沉迷护栏'],
    });
    const conflict = registry.inspectConflict(incoming);

    for (const replacementCanonicalNames of [undefined, { 'concept:沉迷护栏': '防AI沉迷护栏' }]) {
      assert.throws(
        () =>
          registry.resolveConflict(
            incoming,
            { action: 'correct', fingerprint: conflict.fingerprint, replacementCanonicalNames },
            { source: 'proposal-approval', proposalId: 'ep-invalid' },
          ),
        (error) => error.code === 'ENTITY_CONFLICT_INVALID_RESOLUTION',
      );
      assert.deepEqual(registry.get('concept:沉迷护栏'), before);
      assert.equal(registry.get(incoming.entityId), null);
    }
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM entity_revision_events WHERE proposal_id = ?').get('ep-invalid').n,
      0,
    );
  });

  it('rejects duplicate canonical replacements inside one multi-candidate decision', () => {
    registry.upsert(
      [
        entity({ entityId: 'concept:first', canonicalName: 'First Guard', aliases: [] }),
        entity({ entityId: 'concept:second', canonicalName: 'Second Guard', aliases: [] }),
      ],
      { source: 'system' },
    );
    const firstBefore = registry.get('concept:first');
    const secondBefore = registry.get('concept:second');
    const incoming = entity({
      entityId: 'concept:new-guard',
      canonicalName: 'New Guard',
      aliases: ['First Guard', 'Second Guard'],
    });
    const conflict = registry.inspectConflict(incoming);

    assert.throws(
      () =>
        registry.resolveConflict(
          incoming,
          {
            action: 'transfer',
            fingerprint: conflict.fingerprint,
            replacementCanonicalNames: {
              'concept:first': 'Shared Replacement',
              'concept:second': 'Shared Replacement',
            },
          },
          { source: 'proposal-approval', proposalId: 'ep-duplicate-replacement' },
        ),
      (error) => error.code === 'ENTITY_CONFLICT_INVALID_RESOLUTION',
    );
    assert.deepEqual(registry.get('concept:first'), firstBefore);
    assert.deepEqual(registry.get('concept:second'), secondBefore);
    assert.equal(registry.get(incoming.entityId), null);
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM entity_revision_events WHERE proposal_id = ?')
        .get('ep-duplicate-replacement').n,
      0,
    );
  });

  it('rolls back every projection when a later revision insert fails', () => {
    registry.upsert(
      [entity(), entity({ entityId: 'concept:second', canonicalName: 'Second', aliases: ['沉迷护栏'] })],
      { source: 'system' },
    );
    const firstBefore = registry.get('concept:沉迷护栏');
    const secondBefore = registry.get('concept:second');
    const incoming = entity({
      entityId: 'concept:new',
      canonicalName: 'New',
      aliases: ['沉迷护栏'],
    });
    const conflict = registry.inspectConflict(incoming);
    db.exec(`
      CREATE TRIGGER fail_second_resolution_revision
      BEFORE INSERT ON entity_revision_events
      WHEN NEW.proposal_id = 'ep-fail'
        AND (SELECT count(*) FROM entity_revision_events WHERE proposal_id = 'ep-fail') >= 1
      BEGIN
        SELECT RAISE(ABORT, 'forced revision failure');
      END
    `);

    assert.throws(
      () =>
        registry.resolveConflict(
          incoming,
          { action: 'correct', fingerprint: conflict.fingerprint },
          { source: 'proposal-approval', proposalId: 'ep-fail' },
        ),
      /forced revision failure/,
    );
    assert.deepEqual(registry.get('concept:沉迷护栏'), firstBefore);
    assert.deepEqual(registry.get('concept:second'), secondBefore);
    assert.equal(registry.get(incoming.entityId), null);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM entity_revision_events WHERE proposal_id = ?').get('ep-fail').n,
      0,
    );
  });
});
