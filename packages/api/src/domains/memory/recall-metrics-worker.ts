import Database from 'better-sqlite3';
import { RecallMetricsComputer, type RecallMetricsReport } from './RecallMetricsComputer.js';
import type { RecallMetricsQuery } from './RecallMetricsReader.js';

/** Fixed server-owned target; neither module, export nor database comes from HTTP. */
export function readRecallMetricsInProcess(input: {
  databasePath: string;
  query: RecallMetricsQuery;
  toMs: number;
}): RecallMetricsReport {
  const db = new Database(input.databasePath, { readonly: true, fileMustExist: true });
  try {
    return new RecallMetricsComputer(db).computeMetrics({ ...input.query, toMs: input.toMs });
  } finally {
    db.close();
  }
}
