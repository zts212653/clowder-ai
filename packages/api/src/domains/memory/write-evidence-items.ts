import type Database from 'better-sqlite3';
import { pathToAuthority } from './f163-types.js';
import type { EvidenceItem } from './interfaces.js';

export function writeEvidenceItems(db: Database.Database, items: EvidenceItem[]): void {
  // F152 Phase C fix: ON CONFLICT preserves user annotations (generalizable)
  // and first_indexed_at through index rebuilds, instead of DELETE+INSERT.
  const stmt = db.prepare(`
				INSERT INTO evidence_docs
				(anchor, kind, status, title, summary, keywords, source_path, source_hash,
				 superseded_by, materialized_from, updated_at, pack_id, provenance_tier, provenance_source, generalizable,
				 authority, activation, verified_at,
				 source_ids, summary_of_anchor, compression_rationale,
				 contradicts, invalid_at, review_cycle_days,
				 world_id, scene_id, first_indexed_at, drill_down_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(anchor) DO UPDATE SET
				 kind = excluded.kind,
				 status = excluded.status,
				 title = excluded.title,
				 summary = excluded.summary,
				 keywords = excluded.keywords,
				 source_path = excluded.source_path,
				 source_hash = excluded.source_hash,
				 superseded_by = excluded.superseded_by,
				 materialized_from = excluded.materialized_from,
				 updated_at = excluded.updated_at,
				 pack_id = excluded.pack_id,
				 provenance_tier = excluded.provenance_tier,
				 provenance_source = excluded.provenance_source,
				 generalizable = COALESCE(excluded.generalizable, evidence_docs.generalizable),
				 authority = excluded.authority,
				 activation = excluded.activation,
				 verified_at = excluded.verified_at,
				 source_ids = excluded.source_ids,
				 summary_of_anchor = excluded.summary_of_anchor,
				 compression_rationale = excluded.compression_rationale,
				 contradicts = excluded.contradicts,
				 invalid_at = excluded.invalid_at,
				 review_cycle_days = excluded.review_cycle_days,
				 world_id = excluded.world_id,
				 scene_id = excluded.scene_id,
				 first_indexed_at = evidence_docs.first_indexed_at,
				 drill_down_json = excluded.drill_down_json
			`);

  const tx = db.transaction((items: EvidenceItem[]) => {
    for (const item of items) {
      stmt.run(
        item.anchor,
        item.kind,
        item.status,
        item.title,
        item.summary ?? null,
        item.keywords ? JSON.stringify(item.keywords) : null,
        item.sourcePath ?? null,
        item.sourceHash ?? null,
        item.supersededBy ?? null,
        item.materializedFrom ?? null,
        item.updatedAt,
        item.packId ?? null,
        item.provenance?.tier ?? null,
        item.provenance?.source ?? null,
        item.generalizable == null ? null : item.generalizable ? 1 : 0,
        item.authority ?? pathToAuthority(item.sourcePath ?? item.anchor),
        item.activation ?? 'query',
        item.verifiedAt ?? null,
        item.sourceIds ? JSON.stringify(item.sourceIds) : null,
        item.summaryOfAnchor ?? null,
        item.compressionRationale ?? null,
        item.contradicts ? JSON.stringify(item.contradicts) : null,
        item.invalidAt ?? null,
        item.reviewCycleDays ?? null,
        item.worldId ?? null,
        item.sceneId ?? null,
        Date.now(),
        item.drillDown ? JSON.stringify(item.drillDown) : null,
      );
    }
  });

  tx(items);
}
