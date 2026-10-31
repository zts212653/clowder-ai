import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('F260 entity registry conflict and revision invariants', () => {
  let db;
  let registry;

  const entity = (overrides = {}) => ({
    entityId: 'concept:未婚喵',
    type: 'concept',
    canonicalName: '未婚喵（→ 宪宪/fable-5）',
    aliases: ['未婚喵'],
    provenance: [{ source: 'proposal', anchor: 'ep-2' }],
    stance: 'endorsed',
    visibilityScope: 'workspace',
    status: 'active',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  });

  const revisionRows = () => db.prepare('SELECT * FROM entity_revision_events ORDER BY revision_id').all();

  beforeEach(async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { EntityRegistryStore } = await import('../../dist/domains/memory/EntityRegistry.js');
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
    registry = new EntityRegistryStore(db);
  });

  it('records create and update snapshots without smearing old provenance into current truth', () => {
    registry.upsert([entity()], { source: 'system', reason: 'initial fixture' });
    registry.upsert(
      [
        entity({
          canonicalName: '未婚喵（→ 小太阳·砚砚/codex-sol）',
          aliases: ['未婚喵', '未婚猫'],
          provenance: [{ source: 'proposal', anchor: 'ep-3' }],
          updatedAt: '2026-07-18T00:00:00.000Z',
        }),
      ],
      { source: 'system', actorId: 'user-1', proposalId: 'ep-3', reason: 'explicit correction' },
    );

    const rows = revisionRows();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].operation, 'create');
    assert.equal(rows[0].before_json, null);
    assert.deepEqual(JSON.parse(rows[0].after_json).provenance, [{ source: 'proposal', anchor: 'ep-2' }]);
    assert.equal(rows[1].operation, 'update');
    assert.deepEqual(JSON.parse(rows[1].before_json).provenance, [{ source: 'proposal', anchor: 'ep-2' }]);
    assert.deepEqual(JSON.parse(rows[1].after_json).provenance, [{ source: 'proposal', anchor: 'ep-3' }]);
    assert.equal(rows[1].source, 'system');
    assert.equal(rows[1].actor_id, 'user-1');
    assert.equal(rows[1].proposal_id, 'ep-3');
    assert.equal(rows[1].reason, 'explicit correction');
    assert.deepEqual(registry.get('concept:未婚喵').provenance, [{ source: 'proposal', anchor: 'ep-3' }]);
  });

  it('does not create a revision for a byte-equivalent upsert', () => {
    const record = entity();
    registry.upsert([record], { source: 'system' });
    registry.upsert([record], { source: 'system' });
    assert.equal(revisionRows().length, 1);
  });

  it('rejects a proposal surface collision across entity IDs after exact normalization', () => {
    registry.upsert([entity()], { source: 'system' });
    assert.throws(
      () =>
        registry.upsert(
          [
            entity({
              entityId: 'concept:未婚喵2',
              canonicalName: 'Second Unmarried Cat',
              aliases: ['  未婚喵  '],
              provenance: [{ source: 'proposal', anchor: 'ep-4' }],
              updatedAt: '2026-07-18T00:00:00.000Z',
            }),
          ],
          { source: 'proposal-approval', proposalId: 'ep-4', conflictPolicy: 'reject-conflict' },
        ),
      (error) => {
        assert.equal(error.code, 'ENTITY_SURFACE_CONFLICT');
        assert.equal(error.incomingEntityId, 'concept:未婚喵2');
        assert.deepEqual(error.conflictingEntityIds, ['concept:未婚喵']);
        return true;
      },
    );
    assert.equal(registry.get('concept:未婚喵2'), null);
    assert.equal(revisionRows().length, 1, 'failed conflict must not append a revision');
  });

  it('rejects material same-ID rewrites and canonical-name collisions', () => {
    registry.upsert([entity({ aliases: ['fable term'] })], { source: 'system' });
    assert.throws(
      () =>
        registry.upsert(
          [
            entity({
              canonicalName: '未婚喵（→ 小太阳·砚砚/codex-sol）',
              provenance: [{ source: 'proposal', anchor: 'ep-5' }],
            }),
          ],
          { source: 'proposal-approval', conflictPolicy: 'reject-conflict' },
        ),
      (error) => error.code === 'ENTITY_SURFACE_CONFLICT',
    );
    assert.throws(
      () =>
        registry.upsert([entity({ entityId: 'concept:duplicate-canonical', aliases: ['different alias'] })], {
          source: 'proposal-approval',
          conflictPolicy: 'reject-conflict',
        }),
      (error) => error.code === 'ENTITY_SURFACE_CONFLICT',
    );
    assert.equal(registry.get('concept:未婚喵').canonicalName, '未婚喵（→ 宪宪/fable-5）');
    assert.equal(revisionRows().length, 1);
  });

  it('keeps the schema permissive for generic same-surface entities', () => {
    registry.upsert([entity()], { source: 'system' });
    registry.upsert([entity({ entityId: 'concept:未婚喵2', provenance: [{ source: 'system-seed' }] })], {
      source: 'system',
      conflictPolicy: 'allow-update',
    });
    assert.ok(registry.get('concept:未婚喵'));
    assert.ok(registry.get('concept:未婚喵2'));
    assert.equal(revisionRows().length, 2);
  });

  it('rolls back entity and alias mutations when revision insertion fails', () => {
    registry.upsert([entity()], { source: 'system' });
    db.exec(`
      CREATE TRIGGER force_entity_revision_failure
      BEFORE INSERT ON entity_revision_events
      BEGIN
        SELECT RAISE(ABORT, 'forced revision failure');
      END
    `);
    assert.throws(() =>
      registry.upsert(
        [entity({ canonicalName: 'mutated name', aliases: ['mutated alias'], provenance: [{ source: 'mutated' }] })],
        { source: 'system' },
      ),
    );
    const current = registry.get('concept:未婚喵');
    assert.equal(current.canonicalName, '未婚喵（→ 宪宪/fable-5）');
    assert.deepEqual(current.aliases, ['未婚喵']);
    assert.deepEqual(current.provenance, [{ source: 'proposal', anchor: 'ep-2' }]);
    assert.equal(revisionRows().length, 1);
  });

  it('rolls back an earlier batch item when a later item conflicts', () => {
    registry.upsert([entity()], { source: 'system' });
    assert.throws(
      () =>
        registry.upsert(
          [
            entity({ entityId: 'concept:batch-first', canonicalName: 'Batch First', aliases: ['batch-first'] }),
            entity({ entityId: 'concept:batch-conflict', canonicalName: 'Batch Conflict', aliases: ['未婚喵'] }),
          ],
          { source: 'proposal-approval', conflictPolicy: 'reject-conflict' },
        ),
      (error) => error.code === 'ENTITY_SURFACE_CONFLICT',
    );
    assert.equal(registry.get('concept:batch-first'), null);
    assert.equal(registry.get('concept:batch-conflict'), null);
    assert.equal(revisionRows().length, 1);
  });
});
