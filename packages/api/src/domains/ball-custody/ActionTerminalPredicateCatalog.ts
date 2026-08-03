import { createHash } from 'node:crypto';
import {
  type ActionSuccessorActionFamily,
  type ActionTerminalPredicateInput,
  type ActionTerminalPredicateKind,
  actionTerminalPredicateInputSchema,
  DISPATCH_PROPOSED_ACTION_CAPABILITIES,
} from '@cat-cafe/shared';

export type ActionTerminalCompletionResolverId = 'review_delivery' | 'task_done_status';
export type ActionTerminalFreshnessResolverId = 'community_current_head' | 'task_active_owner';
export type ActionTerminalCompletionProducerId =
  | 'external_review_verdict'
  | 'local_review_verdict'
  | 'task_status_transition';
export type ActionTerminalRuntimePortId =
  | 'community_projection'
  | 'message_store'
  | 'task_store'
  | 'action_successor_preflight'
  | 'action_successor_completion';

interface ActionTerminalCapability {
  readonly actionFamily: ActionSuccessorActionFamily;
  readonly kind: ActionTerminalPredicateKind;
  readonly schema: (input: unknown) => ActionTerminalPredicateInput;
  readonly canonicalizer: (
    subjectRef: string,
    predicate: ActionTerminalPredicateInput,
  ) => Omit<CanonicalActionTerminalPredicate, 'digest'>;
  readonly completionResolver: ActionTerminalCompletionResolverId;
  readonly freshnessResolver: ActionTerminalFreshnessResolverId;
  readonly producers: readonly ActionTerminalCompletionProducerId[];
  readonly requiredPorts: readonly ActionTerminalRuntimePortId[];
}

export interface ActionTerminalCapabilityRuntimeReadiness {
  readonly runtimePorts: Partial<Record<ActionTerminalRuntimePortId, unknown>>;
  readonly completionResolvers: ReadonlySet<ActionTerminalCompletionResolverId>;
  readonly freshnessResolvers: ReadonlySet<ActionTerminalFreshnessResolverId>;
  readonly producers: ReadonlySet<ActionTerminalCompletionProducerId>;
}

const MACHINE_EVIDENCE_PREFIXES = [
  'community:',
  'github:',
  'local-review:',
  'ci:',
  'test:',
  'verdict:',
  'git:',
  'commit:',
  'task:',
];
const REVIEW_REENTRY_EVIDENCE_PREFIXES = [...MACHINE_EVIDENCE_PREFIXES, 'message:'];

export interface CanonicalActionTerminalPredicate {
  readonly kind: ActionTerminalPredicateKind;
  readonly subjectRef: string;
  /** Stable across subject revisions such as a new review HEAD. */
  readonly identityKey: string;
  /** Changes when the exact subject revision covered by the action changes. */
  readonly freshnessKey: string;
  readonly digest: string;
  readonly headSha?: string;
  readonly commandDigest?: string;
  readonly revisionSha?: string;
  readonly verdictRef?: string;
}

export type ActionTerminalPredicateErrorCode =
  | 'predicate_not_allowed'
  | 'predicate_subject_unsupported'
  | 'invalid_predicate_parameter';

export class ActionTerminalPredicateError extends Error {
  constructor(
    readonly code: ActionTerminalPredicateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActionTerminalPredicateError';
  }
}

function canonicalizeSubjectRef(value: string): string {
  const trimmed = value.trim();
  const pr = /^pr:([^/\s]+)\/([^#\s]+)#([1-9]\d*)$/i.exec(trimmed);
  if (pr) {
    const [, owner, repo, number] = pr;
    if (owner && repo && number) return `pr:${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  }
  const opaque = /^subject:([a-z][a-z0-9_-]{0,63}):(\S{1,200})$/i.exec(trimmed);
  if (opaque) {
    const [, namespace, id] = opaque;
    if (namespace && id && !id.includes('\u001f')) return `subject:${namespace.toLowerCase()}:${id}`;
  }
  throw new ActionTerminalPredicateError('predicate_subject_unsupported', `unsupported predicate subject: ${value}`);
}

function requirePrSubject(kind: ActionTerminalPredicateKind, subjectRef: string): void {
  if (!subjectRef.startsWith('pr:')) {
    throw new ActionTerminalPredicateError('predicate_subject_unsupported', `${kind} requires a PR subject`);
  }
}

function requireCanonicalGitObjectId(value: string, field: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new ActionTerminalPredicateError(
      'invalid_predicate_parameter',
      `${field} must be a canonical 40- or 64-character lowercase Git OID`,
    );
  }
  return value;
}

function parseReviewDeliveredPredicate(input: unknown): ActionTerminalPredicateInput {
  const parsed = actionTerminalPredicateInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.kind !== 'review_delivered') {
    throw new ActionTerminalPredicateError(
      'invalid_predicate_parameter',
      'review_delivered predicate does not match its registered schema',
    );
  }
  return parsed.data;
}

function canonicalizeReviewDelivered(
  subjectRef: string,
  predicate: ActionTerminalPredicateInput,
): Omit<CanonicalActionTerminalPredicate, 'digest'> {
  if (predicate.kind !== 'review_delivered') {
    throw new ActionTerminalPredicateError(
      'invalid_predicate_parameter',
      'review_delivered canonicalizer received another predicate kind',
    );
  }
  requirePrSubject(predicate.kind, subjectRef);
  const headSha = requireCanonicalGitObjectId(predicate.headSha, 'headSha');
  return {
    kind: predicate.kind,
    subjectRef,
    identityKey: `${predicate.kind}\u001f${subjectRef}`,
    freshnessKey: `head:${headSha}`,
    headSha,
  };
}

function parseTaskDonePredicate(input: unknown): ActionTerminalPredicateInput {
  const parsed = actionTerminalPredicateInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.kind !== 'task_done') {
    throw new ActionTerminalPredicateError(
      'invalid_predicate_parameter',
      'task_done predicate does not match its registered schema',
    );
  }
  return parsed.data;
}

function canonicalizeTaskDone(
  subjectRef: string,
  predicate: ActionTerminalPredicateInput,
): Omit<CanonicalActionTerminalPredicate, 'digest'> {
  if (predicate.kind !== 'task_done') {
    throw new ActionTerminalPredicateError(
      'invalid_predicate_parameter',
      'task_done canonicalizer received another predicate kind',
    );
  }
  const task = /^subject:task:(\S{1,200})$/.exec(subjectRef);
  const taskId = task?.[1];
  if (!taskId) {
    throw new ActionTerminalPredicateError('predicate_subject_unsupported', 'task_done requires a task subject');
  }
  return {
    kind: predicate.kind,
    subjectRef,
    identityKey: `${predicate.kind}\u001f${subjectRef}`,
    freshnessKey: `task:${taskId}`,
  };
}

/*
 * Admitted predicate capabilities live in one executable registry. A schema
 * shape existing in shared types is intentionally not enough: admission is
 * enabled only when canonicalization, server resolution, a production
 * completion producer, and every runtime port are named here and boot-asserted.
 */
export const ACTION_TERMINAL_CAPABILITY_REGISTRY: readonly ActionTerminalCapability[] = Object.freeze([
  {
    actionFamily: DISPATCH_PROPOSED_ACTION_CAPABILITIES[0].actionFamily,
    kind: DISPATCH_PROPOSED_ACTION_CAPABILITIES[0].terminalPredicateKind,
    schema: parseReviewDeliveredPredicate,
    canonicalizer: canonicalizeReviewDelivered,
    completionResolver: 'review_delivery',
    freshnessResolver: 'community_current_head',
    producers: ['external_review_verdict', 'local_review_verdict'],
    requiredPorts: [
      'community_projection',
      'message_store',
      'action_successor_preflight',
      'action_successor_completion',
    ],
  },
  {
    actionFamily: DISPATCH_PROPOSED_ACTION_CAPABILITIES[1].actionFamily,
    kind: DISPATCH_PROPOSED_ACTION_CAPABILITIES[1].terminalPredicateKind,
    schema: parseTaskDonePredicate,
    canonicalizer: canonicalizeTaskDone,
    completionResolver: 'task_done_status',
    freshnessResolver: 'task_active_owner',
    producers: ['task_status_transition'],
    requiredPorts: ['task_store', 'action_successor_completion'],
  },
]);

function getActionTerminalCapability(
  actionFamily: ActionSuccessorActionFamily,
  kind: ActionTerminalPredicateKind,
): ActionTerminalCapability {
  const capability = ACTION_TERMINAL_CAPABILITY_REGISTRY.find(
    (entry) => entry.actionFamily === actionFamily && entry.kind === kind,
  );
  if (!capability) {
    throw new ActionTerminalPredicateError('predicate_not_allowed', `${kind} is not allowed for ${actionFamily}`);
  }
  return capability;
}

export function getActionTerminalCapabilityForPredicateKind(
  kind: ActionTerminalPredicateKind,
): ActionTerminalCapability {
  const matches = ACTION_TERMINAL_CAPABILITY_REGISTRY.filter((entry) => entry.kind === kind);
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(`action terminal capability kind must have exactly one runtime owner: ${kind}`);
  }
  return matches[0];
}

function registerUniqueCapability(
  capability: ActionTerminalCapability,
  identities: Set<string>,
  kinds: Set<ActionTerminalPredicateKind>,
): string {
  const identity = `${capability.actionFamily}:${capability.kind}`;
  if (identities.has(identity)) throw new Error(`duplicate action terminal capability: ${identity}`);
  if (kinds.has(capability.kind)) {
    throw new Error(`action terminal capability kind has multiple runtime owners: ${capability.kind}`);
  }
  identities.add(identity);
  kinds.add(capability.kind);
  return identity;
}

function assertCapabilityRuntimeReady(
  capability: ActionTerminalCapability,
  readiness: ActionTerminalCapabilityRuntimeReadiness,
  identity: string,
): void {
  if (!readiness.completionResolvers.has(capability.completionResolver)) {
    throw new Error(`${identity} requires completion resolver ${capability.completionResolver}`);
  }
  if (!readiness.freshnessResolvers.has(capability.freshnessResolver)) {
    throw new Error(`${identity} requires freshness resolver ${capability.freshnessResolver}`);
  }
  for (const producer of capability.producers) {
    if (!readiness.producers.has(producer)) {
      throw new Error(`${identity} requires producer ${producer}`);
    }
  }
  for (const port of capability.requiredPorts) {
    if (!readiness.runtimePorts[port]) throw new Error(`${identity} requires runtime port ${port}`);
  }
}

export function assertActionTerminalCapabilityRegistryReady(readiness: ActionTerminalCapabilityRuntimeReadiness): void {
  const identities = new Set<string>();
  const kinds = new Set<ActionTerminalPredicateKind>();
  for (const capability of ACTION_TERMINAL_CAPABILITY_REGISTRY) {
    const identity = registerUniqueCapability(capability, identities, kinds);
    assertCapabilityRuntimeReady(capability, readiness, identity);
  }
}

export function canonicalizeActionTerminalPredicate(input: {
  actionFamily: ActionSuccessorActionFamily;
  subjectRef: string;
  predicate: ActionTerminalPredicateInput;
}): CanonicalActionTerminalPredicate {
  const capability = getActionTerminalCapability(input.actionFamily, input.predicate.kind);
  const predicate = capability.schema(input.predicate);
  const subjectRef = canonicalizeSubjectRef(input.subjectRef);
  const fields = capability.canonicalizer(subjectRef, predicate);
  const digest = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  return { ...fields, digest };
}

export function isMachineCheckableCompletionEvidenceRef(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (/^local-review:[^:\s]+:g[1-9]\d*:(?:approved|changes_requested|commented)$/.test(normalized)) return true;
  return (
    normalized.length > 0 &&
    MACHINE_EVIDENCE_PREFIXES.some((prefix) => prefix !== 'local-review:' && normalized.startsWith(prefix))
  );
}

export function isDurableReviewReentryEvidenceRef(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return REVIEW_REENTRY_EVIDENCE_PREFIXES.some(
    (prefix) => normalized.startsWith(prefix) && normalized.length > prefix.length,
  );
}
