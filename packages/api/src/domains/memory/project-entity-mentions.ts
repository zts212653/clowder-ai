import Database from 'better-sqlite3';
import { EntityRegistryStore } from './EntityRegistry.js';
import type { MentionProjectionInput, MentionProjectionResult } from './memory-process-protocol.js';

/** Calculate against one WAL read snapshot. Only the private staging DB is written. */
export function projectEntityMentions(
  source: Database.Database,
  stagingPath: string,
  input: MentionProjectionInput,
): MentionProjectionResult {
  const stage = new Database(stagingPath);
  try {
    return source.transaction(() => {
      const sourceRevision = (
        source.prepare('SELECT revision FROM memory_source_revision WHERE id=1').get() as { revision: number }
      ).revision;
      for (const table of ['entity_registry', 'entity_aliases', 'entity_revision_events']) {
        const schema = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {
          sql: string;
        };
        stage.exec(schema.sql);
        if (table === 'entity_revision_events') continue;
        const rows = source.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
        if (!rows.length) continue;
        const keys = Object.keys(rows[0]!);
        const insert = stage.prepare(
          `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
        );
        stage.transaction(() => {
          for (const row of rows) insert.run(...keys.map((key) => row[key]));
        })();
      }
      stage.exec(`CREATE TABLE entity_mentions (
        entity_id TEXT NOT NULL, doc_anchor TEXT NOT NULL, passage_id TEXT NOT NULL DEFAULT '',
        surface TEXT NOT NULL, surface_norm TEXT NOT NULL, source TEXT NOT NULL,
        provenance_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (entity_id, doc_anchor, passage_id, surface_norm))`);
      const registry = new EntityRegistryStore(stage, source);
      let entityIds: string[] | undefined;
      let docAnchors: string[] | undefined;
      let changed = true;
      if (input.operation === 'entities') {
        changed = registry.upsert(input.entities, input.context);
        entityIds = input.entities.map((entity) => entity.entityId);
      } else if (input.operation === 'resolve-entity') {
        const result = registry.resolveConflict(input.incoming, input.resolution, input.context);
        changed = result.changed;
        entityIds = result.affectedEntityIds;
      } else if (input.docAnchors?.length) {
        const exists = source.prepare('SELECT 1 FROM evidence_docs WHERE anchor = ?');
        docAnchors = input.docAnchors.filter((anchor) => exists.get(anchor));
      } else {
        entityIds = (stage.prepare('SELECT entity_id FROM entity_registry').all() as { entity_id: string }[]).map(
          (row) => row.entity_id,
        );
      }
      if (changed) {
        if (entityIds) registry.refreshMentionsForEntities(entityIds);
        else if (docAnchors?.length) registry.refreshMentions(docAnchors);
      }
      return { sourceRevision, entityIds, docAnchors, changed };
    })();
  } finally {
    stage.close();
  }
}
