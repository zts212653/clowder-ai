/**
 * F163: Experiment logger — records effective_flags + variant_id per search/write.
 * Writes to f163_logs table (Schema V13).
 */

import type Database from 'better-sqlite3';
import type { F163FlagSnapshot } from './f163-types.js';

export class F163ExperimentLogger {
  constructor(private db: Database.Database) {}

  logSearch(variantId: string, flags: F163FlagSnapshot, payload: Record<string, unknown>): void {
    this.db
      .prepare(
        'INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('search', variantId, JSON.stringify(flags), JSON.stringify(payload), new Date().toISOString());
  }

  logWrite(variantId: string, flags: F163FlagSnapshot, payload: Record<string, unknown>): void {
    this.db
      .prepare(
        'INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('write', variantId, JSON.stringify(flags), JSON.stringify(payload), new Date().toISOString());
  }

  log(logType: string, variantId: string, flags: F163FlagSnapshot, payload: Record<string, unknown>): void {
    this.db
      .prepare(
        'INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(logType, variantId, JSON.stringify(flags), JSON.stringify(payload), new Date().toISOString());
  }

  /** F163 Phase B: Log a compression scan action */
  logCompressionScan(variantId: string, flags: F163FlagSnapshot, payload: Record<string, unknown>): void {
    this.db
      .prepare(
        'INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('compression_scan', variantId, JSON.stringify(flags), JSON.stringify(payload), new Date().toISOString());
  }

  /** F163 Phase B: Log a compression apply action */
  logCompressionApply(variantId: string, flags: F163FlagSnapshot, payload: Record<string, unknown>): void {
    this.db
      .prepare(
        'INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('compression_apply', variantId, JSON.stringify(flags), JSON.stringify(payload), new Date().toISOString());
  }
}
