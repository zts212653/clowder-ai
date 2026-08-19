/**
 * F260 Phase A: Entity proposal types.
 *
 * Cats propose new entity registry entries via `cat_cafe_propose_entity`;
 * the operator sees a card in the Approval Hub and approves/rejects.
 * On approve, the backend upserts into EntityRegistry (atomic SQLite).
 * On reject, the proposal is settled (audit trail only).
 *
 * State machine:
 *   pending → approved   (plain approve or an explicit conflict resolution)
 *   pending → rejected   (one-shot)
 * A failed registry mutation compensates approved → pending; the registry
 * projection and revision ledger remain atomic inside SQLite.
 *
 * Design rationale (2026-07-09 opus 质疑 + operator 刹车):
 * This tool is a "door" — the main entry is PR-3's registration nudge
 * (system detects repeated terms → one-click propose). Not a spontaneous-use tool.
 */

import type { ApprovalOriginRef, ApprovalPublication } from './approval-hub.js';

/**
 * Entity types — mirrors the api-side EntityType union (packages/api/src/domains/memory/interfaces.ts).
 * Defined here so shared types can reference it without reverse-depending on @cat-cafe/api.
 */
export type EntityType = 'person' | 'cat' | 'feature' | 'concept' | 'external';

/**
 * F260 stance enum — includes negative values for critique targets.
 * endorsed: canonical positive entity
 * rejected: explicitly rejected name/concept (future: auto-flag)
 * critique_target: entity under critique (e.g. "六边形架构" as critique subject)
 * deliverable_only: entity that is a deliverable, not a concept
 * unknown: default, no stance determined
 */
export const ENTITY_STANCES = Object.freeze([
  'endorsed',
  'rejected',
  'critique_target',
  'deliverable_only',
  'unknown',
] as const);

export type EntityStance = (typeof ENTITY_STANCES)[number];

/** Visibility scope — workspace-wide or private to an owner. */
export const ENTITY_VISIBILITY_SCOPES = Object.freeze(['workspace'] as const);

export type EntityVisibilityScope = 'workspace' | `private:${string}`;

export type EntityProposalStatus = 'pending' | 'approved' | 'rejected';

/** Why an entity proposal cannot be approved as a plain create/update. */
export type EntityConflictReason = 'existing-entity-change' | 'surface-collision';

/** Explicit mutations offered by the F260 conflict-resolution UI. */
export const ENTITY_CONFLICT_RESOLUTION_ACTIONS = Object.freeze([
  'merge-aliases',
  'replace',
  'correct',
  'transfer',
  'polysemy',
] as const);

export type EntityConflictResolutionAction = (typeof ENTITY_CONFLICT_RESOLUTION_ACTIONS)[number];

/**
 * Privacy-minimal entity projection used for conflict decisions.
 * Provenance bodies stay server-side; the operator only receives fields needed to
 * compare current truth with the proposal.
 */
export interface EntityConflictRecord {
  entityId: string;
  entityType: EntityType;
  canonicalName: string;
  aliases: string[];
  stance: string;
  visibilityScope: string;
  status: string;
  updatedAt?: string;
}

/** Derived, refresh-safe conflict context shown by the Approval Hub. */
export interface EntityConflictContext {
  version: 1;
  reason: EntityConflictReason;
  fingerprint: string;
  incoming: EntityConflictRecord;
  candidates: EntityConflictRecord[];
  conflictingSurfaces: string[];
  canonicalReplacementRequiredFor: string[];
  allowedActions: Array<EntityConflictResolutionAction | 'reject'>;
}

/** Body accepted by POST /api/entity-proposals/:proposalId/resolve. */
export interface EntityConflictResolutionRequest {
  action: EntityConflictResolutionAction;
  fingerprint: string;
  replacementCanonicalNames?: Record<string, string>;
}

/** F260-specific `ApprovalItem.detail` projection. */
export interface EntityProposalApprovalDetail {
  entityId: string;
  entityType: EntityType;
  canonicalName: string;
  aliases: string[];
  stance: EntityStance;
  visibilityScope: EntityVisibilityScope;
  rationale: string;
  conflict?: EntityConflictContext;
  conflictError?: string;
}

export interface EntityProposal {
  proposalId: string;
  status: EntityProposalStatus;

  /** Proposed entity ID (e.g. "concept:未婚喵"). */
  entityId: string;
  /** Entity type from registry taxonomy. */
  entityType: EntityType;
  /** Human-readable canonical name. */
  canonicalName: string;
  /** Aliases to register. */
  aliases: string[];
  /** Stance on this entity. */
  stance: EntityStance;
  /** Visibility scope — workspace or private to an owner. */
  visibilityScope: EntityVisibilityScope;
  /** Provenance chain — must include thread anchor. */
  provenance: EntityProposalProvenance[];

  /** Cat-provided rationale for the proposal. */
  rationale: string;

  /** Thread where the proposal was created. */
  sourceThreadId: string;
  /** Cat that created the proposal. */
  sourceCatId: string;
  /** User who owns this approval (operator). */
  ownerUserId: string;
  /** Stable transport retry identity, when the caller supplied one. */
  clientRequestId?: string;
  /** Canonical approval origin persisted for staged recovery retries. */
  approvalOriginRef?: ApprovalOriginRef;

  /** Creation timestamp (epoch ms). */
  createdAt: number;
  /** Who approved (set on approval). */
  approvedBy?: string;
  /** When approved (epoch ms). */
  approvedAt?: number;
  /** Who rejected (set on rejection). */
  rejectedBy?: string;
  /** When rejected (epoch ms). */
  rejectedAt?: number;
  /** Rejection reason. */
  rejectionReason?: string;
  /** Phase-I publication state; absent only on pre-Phase-I records. */
  publication?: ApprovalPublication;
}

export interface EntityProposalProvenance {
  source: string;
  anchor?: string;
  note?: string;
  date?: string;
}
