import type { PawFeelDispositionActor, PawFeelDispositionEvent, PawFeelDispositionProjection } from '@cat-cafe/shared';
import type { CanonicalPawFeelCandidate } from '../friction/paw-feel-source.js';
import { type PawFeelDispositionCommand, PawFeelDispositionCommandSchema, PawFeelPrincipalSchema } from './commands.js';

export type PawFeelTrustedPrincipal = Extract<PawFeelDispositionActor, { kind: 'cat' | 'cvo' }>;

export type PawFeelDispositionServiceErrorCode =
  | 'invalid_principal'
  | 'invalid_command'
  | 'signal_not_found'
  | 'identity_collision'
  | 'idempotency_collision'
  | 'duplicate_target_not_found'
  | 'duplicate_cycle'
  | 'batch_too_large'
  | 'bundle_invalid'
  | 'named_owner_required'
  | 'fix_evidence_invalid'
  | 'legacy_action_disabled';

export class PawFeelDispositionServiceError extends Error {
  constructor(
    readonly code: PawFeelDispositionServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PawFeelDispositionServiceError';
  }
}

export function parsePrincipal(raw: unknown): PawFeelTrustedPrincipal {
  const parsed = PawFeelPrincipalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PawFeelDispositionServiceError(
      'invalid_principal',
      `invalid paw-feel principal: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export function parseCommand(raw: unknown): PawFeelDispositionCommand {
  const parsed = PawFeelDispositionCommandSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PawFeelDispositionServiceError('invalid_command', `invalid command: ${parsed.error.message}`);
  }
  return parsed.data;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function eventIntent(event: PawFeelDispositionEvent): string {
  const { occurredAt: _occurredAt, ...intent } = event;
  return JSON.stringify(canonicalize(intent));
}

export function requireMatchingEvent(existing: PawFeelDispositionEvent, attempted: PawFeelDispositionEvent): void {
  if (eventIntent(existing) !== eventIntent(attempted)) {
    throw new PawFeelDispositionServiceError(
      'idempotency_collision',
      `idempotency collision: eventId ${attempted.eventId} belongs to a different command intent`,
    );
  }
}

export function sameDiscoveryIdentity(
  projection: PawFeelDispositionProjection,
  candidate: CanonicalPawFeelCandidate,
): boolean {
  return (
    projection.signalId === candidate.signalId &&
    projection.sourceMessageId === candidate.sourceMessageId &&
    projection.sourceThreadId === candidate.sourceThreadId &&
    projection.sourceCatId === candidate.sourceCatId &&
    projection.markerDigest === candidate.markerDigest &&
    projection.sameDigestOrdinal === candidate.sameDigestOrdinal
  );
}

export function isLegacyWrite(command: PawFeelDispositionCommand): boolean {
  return (
    command.type === 'route_pending' ||
    command.type === 'confirm_routed' ||
    command.type === 'route_reopened' ||
    command.type === 'close'
  );
}
