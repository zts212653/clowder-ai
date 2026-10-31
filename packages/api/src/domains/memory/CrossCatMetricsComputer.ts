import type Database from 'better-sqlite3';

interface CrossCatMetrics {
  crossCatReformulationSpread: number;
  unverifiedConsumptionRate: number;
  trajectoryCount: number;
  verifiedCount: number;
}

export class CrossCatMetricsComputer {
  constructor(private readonly db: Database.Database) {}

  compute(days: number): CrossCatMetrics {
    const cutoff = Date.now() - days * 86_400_000;

    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN output_verified = 1 THEN 1 ELSE 0 END) as verified
         FROM task_trajectories WHERE created_at >= ?`,
      )
      .get([cutoff]) as { total: number; verified: number };

    const trajectoryCount = countRow.total;
    const verifiedCount = countRow.verified;

    if (trajectoryCount === 0) {
      return { crossCatReformulationSpread: 0, unverifiedConsumptionRate: 0, trajectoryCount: 0, verifiedCount: 0 };
    }

    const reformulationSpread = this.computeReformulationSpread(cutoff);
    const unverifiedRate = this.computeUnverifiedConsumptionRate(cutoff);

    return {
      crossCatReformulationSpread: reformulationSpread,
      unverifiedConsumptionRate: unverifiedRate,
      trajectoryCount,
      verifiedCount,
    };
  }

  private computeReformulationSpread(cutoff: number): number {
    const rows = this.db
      .prepare(
        `SELECT t.cat_id, t.invocation_id,
                (SELECT COUNT(*) FROM recall_events re
                 WHERE re.invocation_id = t.invocation_id AND re.reformulated = 1) as reformulation_count
         FROM task_trajectories t
         WHERE t.created_at >= ?`,
      )
      .all([cutoff]) as Array<{ cat_id: string; invocation_id: string; reformulation_count: number }>;

    if (rows.length < 2) return 0;

    const byCat = new Map<string, number[]>();
    for (const row of rows) {
      const arr = byCat.get(row.cat_id) ?? [];
      arr.push(row.reformulation_count);
      byCat.set(row.cat_id, arr);
    }

    if (byCat.size < 2) return 0;

    const catMeans: number[] = [];
    for (const counts of byCat.values()) {
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
      catMeans.push(mean);
    }

    const grandMean = catMeans.reduce((a, b) => a + b, 0) / catMeans.length;
    const variance = catMeans.reduce((sum, m) => sum + (m - grandMean) ** 2, 0) / catMeans.length;
    return Math.sqrt(variance);
  }

  private computeUnverifiedConsumptionRate(cutoff: number): number {
    const rows = this.db
      .prepare(
        `SELECT t.trajectory_id, t.output_verified, t.invocation_id
         FROM task_trajectories t
         WHERE t.created_at >= ?`,
      )
      .all([cutoff]) as Array<{ trajectory_id: string; output_verified: number; invocation_id: string }>;

    let withConsumed = 0;
    let consumedButNotVerified = 0;

    for (const row of rows) {
      const consumed = this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM recall_events
           WHERE invocation_id = ? AND consumed_json != '[]' AND consumed_json != ''`,
        )
        .get([row.invocation_id]) as { cnt: number };

      if (consumed.cnt > 0) {
        withConsumed++;
        if (row.output_verified === 0) consumedButNotVerified++;
      }
    }

    return withConsumed > 0 ? consumedButNotVerified / withConsumed : 0;
  }
}
