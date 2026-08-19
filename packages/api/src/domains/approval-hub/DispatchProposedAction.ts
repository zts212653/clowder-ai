import { createHash } from 'node:crypto';
import { type ActionSuccessorRequestMetadata, actionSuccessorMetadataSchema } from '@cat-cafe/shared';
import {
  type CanonicalActionTerminalPredicate,
  canonicalizeActionTerminalPredicate,
} from '../ball-custody/ActionTerminalPredicateCatalog.js';

export class DispatchProposedActionError extends Error {
  constructor(
    readonly code:
      | 'proposed_action_required'
      | 'proposed_action_transition_unsupported'
      | 'proposed_action_target_cardinality',
    message: string,
  ) {
    super(message);
    this.name = 'DispatchProposedActionError';
  }
}

export interface ValidatedDispatchProposedAction {
  action: ActionSuccessorRequestMetadata;
  terminalPredicate: CanonicalActionTerminalPredicate;
  envelopeDigest: string;
}

/**
 * F246 owns only a proposed initial structured transfer. Replacement, return,
 * and re-entry remain direct F167 flows; admitting them here would require a
 * second approval lifecycle. A first existing-standing claim is also admitted
 * by F167, but its canonical negative-authorization check shares the atomic
 * first-claim boundary so it cannot bypass a pending or rejected decision.
 */
export function validateDispatchProposedAction(
  input: unknown,
  targetCats: readonly string[],
): ValidatedDispatchProposedAction {
  if (input === undefined) {
    throw new DispatchProposedActionError(
      'proposed_action_required',
      'assign_work requires proposedAction with an executable action identity',
    );
  }
  const action = actionSuccessorMetadataSchema.parse(input);
  if (
    action.replace ||
    action.returnToPredecessor ||
    action.reviewReentry ||
    action.claimOrigin === 'existing_standing'
  ) {
    throw new DispatchProposedActionError(
      'proposed_action_transition_unsupported',
      'assign_work approval supports only a new structured ActionSuccessor claim',
    );
  }

  const holders = [...new Set(targetCats.map((catId) => catId.trim()).filter(Boolean))];
  if (
    holders.length !== targetCats.length ||
    (action.mode === 'single' && holders.length !== 1) ||
    (action.mode === 'parallel' && holders.length < 2)
  ) {
    throw new DispatchProposedActionError(
      'proposed_action_target_cardinality',
      action.mode === 'single'
        ? 'single proposedAction requires exactly one unique target cat'
        : 'parallel proposedAction requires at least two unique target cats',
    );
  }
  if (!action.terminalPredicate) {
    throw new DispatchProposedActionError(
      'proposed_action_transition_unsupported',
      'assign_work proposedAction requires a typed terminal predicate',
    );
  }

  // This catalog lookup is the executable capability gate. A shared schema
  // shape alone never authorizes publication.
  const terminalPredicate = canonicalizeActionTerminalPredicate({
    actionFamily: action.actionFamily,
    subjectRef: action.subjectRef,
    predicate: action.terminalPredicate,
  });
  const canonicalEnvelope = {
    action,
    holderCatIds: [...holders].sort(),
    terminalPredicateDigest: terminalPredicate.digest,
  };
  const envelopeDigest = `sha256:${createHash('sha256').update(JSON.stringify(canonicalEnvelope)).digest('hex')}`;
  return { action, terminalPredicate, envelopeDigest };
}
