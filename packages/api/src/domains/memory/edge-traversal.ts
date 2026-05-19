// F200 Phase A (PG-3): Record edge traversals for Phase C edge weights
import type Database from 'better-sqlite3';

interface TraversedEdge {
  from: string;
  to: string;
  relation: string;
}

export function recordEdgeTraversals(db: Database.Database, edges: TraversedEdge[]): void {
  if (edges.length === 0) return;
  const stmt = db.prepare(`
    UPDATE edges SET
      traversal_count = COALESCE(traversal_count, 0) + 1,
      last_traversed_at = ?
    WHERE from_anchor = ? AND to_anchor = ? AND relation = ?
  `);
  const now = new Date().toISOString();
  const tx = db.transaction((items: TraversedEdge[]) => {
    for (const e of items) {
      stmt.run(now, e.from, e.to, e.relation);
    }
  });
  try {
    tx(edges);
  } catch {
    // fire-and-forget: traversal recording must not break graph queries
  }
}
