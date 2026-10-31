import type Database from 'better-sqlite3';

interface OrphanEdge {
  from_anchor: string;
  to_anchor: string;
  relation: string;
}

interface ClassifiedEdge {
  from_anchor: string;
  to_anchor: string;
  relation: string;
  action: 'update' | 'delete' | 'review';
  new_to_anchor?: string;
}

export interface OrphanEdgeClassification {
  id:
    | 'feature_ref_zero_pad'
    | 'feature_ref_true_ghost'
    | 'wikilink_code_artifact'
    | 'wikilink_potential_doc'
    | 'related_field_ghost';
  edges: ClassifiedEdge[];
}

export interface OrphanDryRunReport {
  classifications: OrphanEdgeClassification[];
  totalOrphansBefore: number;
  autoFixableCount: number;
  reviewCount: number;
  sqlPreview: string[];
}

export interface OrphanApplyResult {
  applied: number;
  skippedReview: number;
  backupTable: string;
}

const CODE_ARTIFACT_PATTERN = /^[a-z]+[A-Z][a-zA-Z]*$|^[a-zA-Z]+(\.[a-zA-Z]+)+$/;

function getExistingAnchors(db: Database.Database): Set<string> {
  const rows = db.prepare('SELECT anchor FROM evidence_docs').all() as Array<{ anchor: string }>;
  return new Set(rows.map((r) => r.anchor));
}

function getOrphanEdges(db: Database.Database): OrphanEdge[] {
  return db
    .prepare(
      `SELECT from_anchor, to_anchor, relation FROM edges
       WHERE from_anchor NOT IN (SELECT anchor FROM evidence_docs)
          OR to_anchor NOT IN (SELECT anchor FROM evidence_docs)`,
    )
    .all() as OrphanEdge[];
}

function canonicalizeFeatureRef(ref: string): string | null {
  const m = ref.match(/^F(\d{2,4})$/);
  if (!m) return null;
  const num = parseInt(m[1]!, 10);
  if (num > 999) return null;
  return `F${String(num).padStart(3, '0')}`;
}

export function classifyOrphanEdges(
  db: Database.Database,
  options?: { diskAnchors?: Set<string> },
): OrphanEdgeClassification[] {
  const existing = getExistingAnchors(db);
  const orphans = getOrphanEdges(db);
  const diskAnchors = options?.diskAnchors;

  const buckets: Record<OrphanEdgeClassification['id'], ClassifiedEdge[]> = {
    feature_ref_zero_pad: [],
    feature_ref_true_ghost: [],
    wikilink_code_artifact: [],
    wikilink_potential_doc: [],
    related_field_ghost: [],
  };

  for (const edge of orphans) {
    const isToOrphan = !existing.has(edge.to_anchor);

    if (edge.relation === 'feature_ref' && isToOrphan) {
      const canonical = canonicalizeFeatureRef(edge.to_anchor);
      if (!existing.has(edge.from_anchor)) {
        buckets.feature_ref_true_ghost.push({ ...edge, action: 'delete' });
      } else if (canonical && canonical !== edge.to_anchor && existing.has(canonical)) {
        buckets.feature_ref_zero_pad.push({
          ...edge,
          action: 'update',
          new_to_anchor: canonical,
        });
      } else if (diskAnchors?.has(edge.to_anchor)) {
        buckets.wikilink_potential_doc.push({ ...edge, action: 'review' });
      } else {
        buckets.feature_ref_true_ghost.push({ ...edge, action: 'delete' });
      }
    } else if (edge.relation === 'wikilink' && isToOrphan) {
      if (!existing.has(edge.from_anchor)) {
        buckets.related_field_ghost.push({ ...edge, action: 'delete' });
      } else if (CODE_ARTIFACT_PATTERN.test(edge.to_anchor)) {
        buckets.wikilink_code_artifact.push({ ...edge, action: 'delete' });
      } else {
        buckets.wikilink_potential_doc.push({ ...edge, action: 'review' });
      }
    } else if (isToOrphan || !existing.has(edge.from_anchor)) {
      if (isToOrphan && diskAnchors?.has(edge.to_anchor)) {
        buckets.wikilink_potential_doc.push({ ...edge, action: 'review' });
      } else {
        buckets.related_field_ghost.push({ ...edge, action: 'delete' });
      }
    }
  }

  return Object.entries(buckets).map(([id, edges]) => ({
    id: id as OrphanEdgeClassification['id'],
    edges,
  }));
}

export function dryRunOrphanRepair(db: Database.Database, options?: { diskAnchors?: Set<string> }): OrphanDryRunReport {
  const classifications = classifyOrphanEdges(db, options);
  let autoFixableCount = 0;
  let reviewCount = 0;
  const sqlPreview: string[] = [];

  for (const c of classifications) {
    for (const edge of c.edges) {
      if (edge.action === 'review') {
        reviewCount++;
      } else {
        autoFixableCount++;
        if (edge.action === 'update' && edge.new_to_anchor) {
          sqlPreview.push(
            `UPDATE edges SET to_anchor = '${edge.new_to_anchor}' WHERE from_anchor = '${edge.from_anchor}' AND to_anchor = '${edge.to_anchor}' AND relation = '${edge.relation}';`,
          );
        } else if (edge.action === 'delete') {
          sqlPreview.push(
            `DELETE FROM edges WHERE from_anchor = '${edge.from_anchor}' AND to_anchor = '${edge.to_anchor}' AND relation = '${edge.relation}';`,
          );
        }
      }
    }
  }

  const totalOrphansBefore = classifications.reduce((s, c) => s + c.edges.length, 0);

  return { classifications, totalOrphansBefore, autoFixableCount, reviewCount, sqlPreview };
}

export function applyOrphanRepair(db: Database.Database, report: OrphanDryRunReport): OrphanApplyResult {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T.]/g, '')
    .slice(0, 17);
  const backupTable = `edges_backup_${ts}`;
  db.exec(`CREATE TABLE ${backupTable} AS SELECT * FROM edges`);

  let applied = 0;
  let skippedReview = 0;

  const checkExistsStmt = db.prepare(
    'SELECT 1 FROM edges WHERE from_anchor = ? AND to_anchor = ? AND relation = ? LIMIT 1',
  );
  const updateStmt = db.prepare(
    'UPDATE edges SET to_anchor = ? WHERE from_anchor = ? AND to_anchor = ? AND relation = ?',
  );
  const deleteStmt = db.prepare('DELETE FROM edges WHERE from_anchor = ? AND to_anchor = ? AND relation = ?');

  const applyTxn = db.transaction(() => {
    for (const c of report.classifications) {
      for (const edge of c.edges) {
        if (edge.action === 'update' && edge.new_to_anchor) {
          const exists = checkExistsStmt.get(edge.from_anchor, edge.new_to_anchor, edge.relation);
          if (exists) {
            const r = deleteStmt.run(edge.from_anchor, edge.to_anchor, edge.relation);
            applied += r.changes;
          } else {
            const r = updateStmt.run(edge.new_to_anchor, edge.from_anchor, edge.to_anchor, edge.relation);
            applied += r.changes;
          }
        } else if (edge.action === 'delete') {
          const r = deleteStmt.run(edge.from_anchor, edge.to_anchor, edge.relation);
          applied += r.changes;
        } else if (edge.action === 'review') {
          skippedReview++;
        }
      }
    }
  });
  applyTxn();

  return { applied, skippedReview, backupTable };
}
