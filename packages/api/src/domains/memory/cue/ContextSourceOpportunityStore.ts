import type { ContextSourceEvidenceV1 } from '@cat-cafe/shared';
import { contextSourceEvidenceV1Schema } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ContextSourceOmission } from './context-source-omission.js';

const ingressSchema = z
  .object({
    kind: z.enum(['owner', 'queue_agent']),
    sourceMessageId: z.string().min(1).max(200),
    actionSuccessorFence: z
      .object({
        leaseId: z.string().min(1),
        generation: z.number().int().positive(),
        dispatchId: z.string().min(1),
        terminalPredicateDigest: z.string().optional(),
        invocationLineageRef: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Content-free Cue Plane lifecycle metadata, never a fact or source-body cache. */
export interface ContextSourceOpportunityRecord {
  opportunityId: string;
  scopeKey: string;
  contextEpoch: number;
  sourceMessageId: string;
  consumerCatId: string;
  variant: 'fresh_context_sources' | 'authorized_task_sources';
  evidence: ContextSourceEvidenceV1;
  occurredAt: number;
  expiresAt: number;
  committed: boolean;
  ingress: {
    kind: 'owner' | 'queue_agent';
    sourceMessageId: string;
    actionSuccessorFence?: import('../../ball-custody/ActionSuccessorAdmissionContract.js').ActionSuccessorFence;
  };
  authorityDigest: string;
}

export const CONTEXT_SOURCE_OPPORTUNITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_cue_context_opportunities (
  opportunity_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  context_epoch INTEGER NOT NULL CHECK(context_epoch > 0),
  source_message_id TEXT NOT NULL,
  consumer_cat_id TEXT NOT NULL,
  variant TEXT NOT NULL CHECK(variant IN ('fresh_context_sources','authorized_task_sources')),
  evidence_json TEXT NOT NULL,
  ingress_json TEXT NOT NULL,
  authority_digest TEXT NOT NULL,
  omissions_json TEXT NOT NULL DEFAULT '[]',
  occurred_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  committed_generation_id TEXT,
  UNIQUE(scope_key, context_epoch, consumer_cat_id)
);`;

interface Row {
  opportunity_id: string;
  scope_key: string;
  context_epoch: number;
  source_message_id: string;
  consumer_cat_id: string;
  variant: ContextSourceOpportunityRecord['variant'];
  evidence_json: string;
  occurred_at: number;
  expires_at: number;
  committed_generation_id: string | null;
  ingress_json: string;
  authority_digest: string;
}

export class ContextSourceOpportunityStore {
  constructor(private readonly db: Database.Database) {}

  find(
    scopeKey: string,
    contextEpoch: number,
    sourceMessageId: string,
    consumerCatId: string,
  ): ContextSourceOpportunityRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM memory_cue_context_opportunities
      WHERE scope_key=? AND context_epoch=? AND source_message_id=? AND consumer_cat_id=?`)
      .get(scopeKey, contextEpoch, sourceMessageId, consumerCatId) as Row | undefined;
    if (!row) return null;
    return this.decode(row);
  }

  get(opportunityId: string): ContextSourceOpportunityRecord | null {
    const row = this.db
      .prepare('SELECT * FROM memory_cue_context_opportunities WHERE opportunity_id=?')
      .get(opportunityId) as Row | undefined;
    return row ? this.decode(row) : null;
  }

  private decode(row: Row): ContextSourceOpportunityRecord | null {
    let json: unknown;
    let ingress: unknown;
    try {
      json = JSON.parse(row.evidence_json);
      ingress = JSON.parse(row.ingress_json);
    } catch {
      return null;
    }
    const evidence = contextSourceEvidenceV1Schema.safeParse(json);
    const frame = ingressSchema.safeParse(ingress);
    if (!evidence.success || !frame.success || !/^[0-9a-f]{64}$/.test(row.authority_digest)) return null;
    return {
      opportunityId: row.opportunity_id,
      scopeKey: row.scope_key,
      contextEpoch: row.context_epoch,
      sourceMessageId: row.source_message_id,
      consumerCatId: row.consumer_cat_id,
      variant: row.variant,
      evidence: evidence.data,
      occurredAt: row.occurred_at,
      expiresAt: row.expires_at,
      committed: row.committed_generation_id !== null,
      ingress: frame.data,
      authorityDigest: row.authority_digest,
    };
  }

  prepare(record: ContextSourceOpportunityRecord): ContextSourceOpportunityRecord | null {
    this.db
      .prepare(`INSERT OR IGNORE INTO memory_cue_context_opportunities
      (opportunity_id,scope_key,context_epoch,source_message_id,consumer_cat_id,variant,evidence_json,occurred_at,expires_at,ingress_json,authority_digest)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        record.opportunityId,
        record.scopeKey,
        record.contextEpoch,
        record.sourceMessageId,
        record.consumerCatId,
        record.variant,
        JSON.stringify(record.evidence),
        record.occurredAt,
        record.expiresAt,
        JSON.stringify(record.ingress),
        record.authorityDigest,
      );
    return this.find(record.scopeKey, record.contextEpoch, record.sourceMessageId, record.consumerCatId);
  }

  markProviderCommitted(opportunityId: string, generationId: string): void {
    this.db
      .prepare(`UPDATE memory_cue_context_opportunities SET committed_generation_id=?
      WHERE opportunity_id=? AND committed_generation_id IS NULL`)
      .run(generationId, opportunityId);
  }

  recordOmission(opportunityId: string, reason: ContextSourceOmission): void {
    this.db
      .prepare(`UPDATE memory_cue_context_opportunities SET omissions_json=
      json_insert(omissions_json,'$[#]',json_object('reason',?,'at',?))
      WHERE opportunity_id=? AND json_array_length(omissions_json)<100`)
      .run(reason, Date.now(), opportunityId);
  }
}
