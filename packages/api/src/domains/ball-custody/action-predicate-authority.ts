import type { ActionFreshnessResolution, ActionSubjectTruthResolver } from './ActionSubjectTruthResolver.js';
import type { ActionSuccessorAdmissionInput } from './ActionSuccessorAdmissionContract.js';
import type { CanonicalActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import type {
  ActionCompletionCandidateSnapshot,
  ActionCompletionVerdict,
} from './action-successor-completion-state-machine.js';
import { ActionSuccessorStandingError, type ActionSuccessorStandingSnapshot } from './action-successor-standing.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';
import {
  type ActionTerminalProviderBinding,
  parseActionTerminalProviderBinding,
} from './action-terminal-provider-binding.js';

/** Host-only admission identity. The proposed holder is never the invoking principal. */
export type ActionFreshnessContext = Pick<
  ActionSuccessorAdmissionInput,
  'tenantScope' | 'actorCatId' | 'sourceThreadId' | 'targetThreadId' | 'holderCatIds'
>;

/** This closure comes from trusted Host composition, never from plugin protocol data.
 * It rechecks authority and serializes the write with inventory changes. Provider IO
 * must finish before entering it; the original lease store still owns the CAS. */
export interface ActionPredicateWriteAuthority {
  withAuthority<T>(write: () => Promise<T>): Promise<T>;
}
export interface ActionFreshnessProviderAuthority extends ActionPredicateWriteAuthority {
  readonly binding: ActionTerminalProviderBinding;
}
export type ActionCompletionAuthorization =
  | (ActionPredicateWriteAuthority & {
      readonly status: 'authorized';
      resolveCompletion(
        predicate: CanonicalActionTerminalPredicate,
        candidate: ActionCompletionCandidateSnapshot,
      ): Promise<ActionCompletionVerdict>;
    })
  | { readonly status: 'mismatch' | 'insufficient'; readonly reason: string };

/** Durable approved dispatch recovery is not a native completion invocation. */
export type ActionDispatchRecoveryAuthorization =
  | (ActionPredicateWriteAuthority & {
      readonly status: 'authorized';
      resolveFreshness(): Promise<ActionFreshnessResolution>;
    })
  | { readonly status: 'insufficient'; readonly reason: string };

/** Injected into the neutral resolver; a package cannot select or implement this Host port. */
export interface ActionPredicateProvider {
  resolveFreshness(
    predicate: CanonicalActionTerminalPredicate,
    context: ActionFreshnessContext,
  ): Promise<ActionFreshnessResolution>;
  authorizeCompletion(lease: ActionSuccessorLease, actor: { catId: string }): Promise<ActionCompletionAuthorization>;
  authorizeDispatchRecovery?(
    lease: ActionSuccessorLease,
    context: ActionFreshnessContext,
  ): Promise<ActionDispatchRecoveryAuthorization>;
}

export function withActionPredicateAuthority<T>(
  authority: ActionPredicateWriteAuthority | undefined,
  write: () => Promise<T>,
): Promise<T> {
  return authority ? authority.withAuthority(write) : write();
}

type StandingContext = ActionSuccessorStandingSnapshot &
  Partial<Pick<ActionFreshnessContext, 'actorCatId' | 'sourceThreadId'>>;
export async function resolveAdmissionFreshness(
  resolver: Pick<ActionSubjectTruthResolver, 'resolveFreshness'>,
  predicate: CanonicalActionTerminalPredicate,
  input: StandingContext,
): Promise<ActionFreshnessResolution> {
  // Legacy task preflight has no invoking actor. It may still use its task resolver;
  // a plugin resolver must refuse missing context, never infer it from the assignment.
  const context =
    input.actorCatId && input.sourceThreadId
      ? {
          tenantScope: input.tenantScope,
          actorCatId: input.actorCatId,
          sourceThreadId: input.sourceThreadId,
          targetThreadId: input.targetThreadId,
          holderCatIds: [...input.holderCatIds],
        }
      : undefined;
  const freshness = await resolver.resolveFreshness(predicate, context);
  if (freshness.status !== 'verified') return freshness;
  if (freshness.freshnessKey !== predicate.freshnessKey)
    return {
      status: 'mismatch',
      reason: 'verified freshness identity does not match the canonical predicate',
      evidenceRef: freshness.evidenceRef,
    };
  if (!freshness.providerAuthority) return freshness;
  const authority = freshness.providerAuthority;
  const binding = parseActionTerminalProviderBinding(authority.binding, input.tenantScope);
  if (!binding || typeof authority.withAuthority !== 'function')
    throw new Error('provider authority requires a binding and write guard');
  return {
    ...freshness,
    providerAuthority: {
      binding: Object.freeze(binding),
      withAuthority: authority.withAuthority.bind(authority),
    },
  };
}

export async function requireAdmissionFreshness(
  resolver: Pick<ActionSubjectTruthResolver, 'resolveFreshness'>,
  predicate: CanonicalActionTerminalPredicate,
  input: StandingContext,
): Promise<Extract<ActionFreshnessResolution, { status: 'verified' }>> {
  const freshness = await resolveAdmissionFreshness(resolver, predicate, input);
  if (freshness.status !== 'verified') throw new ActionSuccessorStandingError(freshness.status, freshness.reason);
  return freshness;
}
