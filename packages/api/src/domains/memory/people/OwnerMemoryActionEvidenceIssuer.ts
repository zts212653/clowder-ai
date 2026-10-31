import { createHash } from 'node:crypto';
import {
  type OwnerMemoryActionEvidence,
  ownerMemoryActionEvidenceSchema,
  type PersonMemoryOwnerActionKind,
} from '@cat-cafe/shared';
import type { OwnerMemoryActionCommand } from './person-memory-owner-action-contract.js';

const issuedEvidenceCapabilities = new WeakSet<object>();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function ownerActionDigest(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')}`;
}

function actionTarget(command: OwnerMemoryActionCommand): OwnerMemoryActionEvidence['target'] {
  if (command.action === 'correct_claim' || command.action === 'retire_claim') {
    return {
      personId: command.personId,
      itemKind: 'claim',
      itemId: command.claimId,
      expectedRevision: command.expectedRevision,
    };
  }
  if (command.action === 'amend_event') {
    return {
      personId: command.personId,
      itemKind: 'event',
      itemId: command.eventId,
      expectedRevision: command.expectedRevision,
    };
  }
  return {
    personId: command.personId,
    itemKind: 'person',
    itemId: command.personId,
    expectedRevision: command.expectedPersonRevision,
  };
}

function statementFor(command: OwnerMemoryActionCommand): unknown {
  if (command.action === 'correct_claim' || command.action === 'amend_event') return command.payload;
  if (command.action === 'retire_claim') return { intent: 'retire_claim' };
  return { intent: 'hard_forget_person', confirmed: true };
}

export function ownerActionRequestDigest(ownerUserId: string, command: OwnerMemoryActionCommand): string {
  return ownerActionDigest('f276-owner-action-request-v1', { ownerUserId, command });
}

export function ownerActionStatementDigest(command: OwnerMemoryActionCommand): string {
  return ownerActionDigest('f276-owner-action-statement-v1', statementFor(command));
}

export interface IssueOwnerMemoryActionEvidenceInput {
  ownerUserId: string;
  sessionBindingId: string;
  csrfToken: string;
  command: OwnerMemoryActionCommand;
  requestDigest: string;
  sourceState: OwnerMemoryActionEvidence['sourceState'];
  issuedAt: number;
}

/**
 * Server-private issuer for browser owner actions. Raw session and CSRF secrets
 * are reduced to domain-separated digests and never enter canonical memory.
 */
export class OwnerMemoryActionEvidenceIssuer {
  issue(input: IssueOwnerMemoryActionEvidenceInput): OwnerMemoryActionEvidence {
    const target = actionTarget(input.command);
    const statementDigest = ownerActionStatementDigest(input.command);
    const actionIdDigest = ownerActionDigest('f276-owner-action-id-v1', {
      ownerUserId: input.ownerUserId,
      requestId: input.command.requestId,
      requestDigest: input.requestDigest,
      issuedAt: input.issuedAt,
      sessionBindingId: input.sessionBindingId,
    });
    const unsigned = {
      kind: 'owner_memory_action' as const,
      actionId: `owner_action_${actionIdDigest.slice('sha256:'.length, 'sha256:'.length + 40)}`,
      action: input.command.action,
      ownerUserId: input.ownerUserId,
      sessionBindingDigest: ownerActionDigest('f276-owner-session-binding-v1', input.sessionBindingId),
      csrfVerificationDigest: ownerActionDigest('f276-owner-csrf-verification-v1', input.csrfToken),
      target,
      requestId: input.command.requestId,
      requestDigest: input.requestDigest,
      statementDigest,
      sourceState: input.sourceState,
      issuedAt: input.issuedAt,
    };
    const evidence = ownerMemoryActionEvidenceSchema.parse({
      ...unsigned,
      evidenceDigest: ownerActionDigest('f276-owner-action-evidence-v1', unsigned),
    });
    issuedEvidenceCapabilities.add(evidence);
    return evidence;
  }
}

export function verifyOwnerMemoryActionEvidence(input: {
  evidence: OwnerMemoryActionEvidence;
  ownerUserId?: string;
  command?: OwnerMemoryActionCommand;
  requireLiveIssuerCapability?: boolean;
}): boolean {
  const parsed = ownerMemoryActionEvidenceSchema.safeParse(input.evidence);
  if (!parsed.success) return false;
  if (input.requireLiveIssuerCapability && !issuedEvidenceCapabilities.has(input.evidence)) return false;
  const { evidenceDigest, ...unsigned } = parsed.data;
  if (evidenceDigest !== ownerActionDigest('f276-owner-action-evidence-v1', unsigned)) return false;
  if (input.ownerUserId && parsed.data.ownerUserId !== input.ownerUserId) return false;
  if (!input.command) return true;
  const command = input.command;
  return (
    parsed.data.action === command.action &&
    parsed.data.requestId === command.requestId &&
    parsed.data.requestDigest === ownerActionRequestDigest(parsed.data.ownerUserId, command) &&
    parsed.data.statementDigest === ownerActionStatementDigest(command) &&
    JSON.stringify(parsed.data.target) === JSON.stringify(actionTarget(command))
  );
}

export function ownerActionDisplayVerb(action: PersonMemoryOwnerActionKind): '修改' | '退役' | '修订' | '删除' {
  if (action === 'correct_claim') return '修改';
  if (action === 'retire_claim') return '退役';
  if (action === 'amend_event') return '修订';
  return '删除';
}
