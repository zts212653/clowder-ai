import type { RequestGenerationSegmentState, RequestGenerationSourceRef } from '@cat-cafe/shared';
import { renderUserCapsuleSection } from '@cat-cafe/shared/profile-contract';
import type { MemoryCueSourceReader } from '../../../memory/cue/MemoryCueSourceReader.js';
import type { FileProfileRepository } from '../profile/ProfileRepository.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';

const KEYED_DIGEST = /^hmac-sha256:[a-f0-9]{64}$/;
const MEMORY_CUE_PREFIX = 'memory-cue:v1:';
export const CAT_CAFE_SYSTEM_PROMPT_SOURCE_REF = 'registry:cat-cafe-owned';

type MemoryCueSourceCoordinate = {
  readonly family: 'person_memory' | 'evidence' | 'taste';
  readonly anchor: string;
  readonly revision: string;
};

export function encodeMemoryCueSourceRef(input: MemoryCueSourceCoordinate): string {
  return `${MEMORY_CUE_PREFIX}${Buffer.from(JSON.stringify(input), 'utf8').toString('base64url')}`;
}

function decodeMemoryCueSourceRef(value: string): MemoryCueSourceCoordinate | null {
  if (!value.startsWith(MEMORY_CUE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(MEMORY_CUE_PREFIX.length), 'base64url').toString('utf8')) as {
      family?: unknown;
      anchor?: unknown;
      revision?: unknown;
    };
    if (
      (parsed.family !== 'person_memory' && parsed.family !== 'evidence' && parsed.family !== 'taste') ||
      typeof parsed.anchor !== 'string' ||
      !parsed.anchor ||
      typeof parsed.revision !== 'string' ||
      !parsed.revision
    ) {
      return null;
    }
    return { family: parsed.family, anchor: parsed.anchor, revision: parsed.revision };
  } catch {
    return null;
  }
}

export function encodeProfileSourceRef(kind: 'capsule' | 'primer', digest: string): string {
  return `profile-${kind}:${digest}`;
}

export interface RequestGenerationSourcePolicyInput {
  readonly userId: string;
  readonly threadId: string;
  readonly invocationId: string;
  readonly catId?: string;
  readonly keyedContentDigest?: (value: string) => Promise<string>;
  readonly messageStore?: Pick<IMessageStore, 'getById'>;
  readonly threadStore?: Pick<IThreadStore, 'get'>;
  readonly profileRepository?: Pick<FileProfileRepository, 'readCapsule' | 'scope' | 'readPrimer'>;
  readonly memoryCueSourceReader?: MemoryCueSourceReader;
}

export function requestGenerationSourceKey(sourceRef: RequestGenerationSourceRef): string {
  return `${sourceRef.owner}\0${sourceRef.ref}`;
}

async function resolveMessageSource(
  sourceRef: RequestGenerationSourceRef,
  input: RequestGenerationSourcePolicyInput,
): Promise<RequestGenerationSegmentState> {
  const prefix = `${input.threadId}:`;
  if (!sourceRef.ref.startsWith(prefix)) return 'redacted';
  if (!input.messageStore) return 'unknown';
  const messageId = sourceRef.ref.slice(prefix.length);
  if (!messageId) return 'unknown';
  const message = await input.messageStore.getById(messageId);
  if (!message) return 'unknown';
  if (message.threadId !== input.threadId || message.userId !== input.userId) return 'redacted';
  if (message._tombstone || message.recall) return 'deleted';
  if (message.deletedAt !== undefined) return 'redacted';
  return 'available';
}

async function resolveMemorySource(
  sourceRef: RequestGenerationSourceRef,
  input: RequestGenerationSourcePolicyInput,
): Promise<RequestGenerationSegmentState> {
  const coordinate = decodeMemoryCueSourceRef(sourceRef.ref);
  if (!coordinate || !input.memoryCueSourceReader) return 'unknown';
  const result = await input.memoryCueSourceReader
    .read({
      family: coordinate.family,
      anchor: coordinate.anchor,
      expectedRevision: coordinate.revision,
      scope: { ownerUserId: input.userId, threadId: input.threadId, invocationId: input.invocationId },
    })
    .catch(() => null);
  if (!result) return 'unknown';
  if (result.status === 'ok') return 'available';
  if (result.invalidationReason === 'source_forgotten') return 'deleted';
  if (result.invalidationReason === 'scope_revoked') return 'redacted';
  return result.invalidationReason ? 'redacted' : 'unknown';
}

async function resolveProfileSource(
  sourceRef: RequestGenerationSourceRef,
  input: RequestGenerationSourcePolicyInput,
): Promise<RequestGenerationSegmentState> {
  if (!input.profileRepository) return 'unknown';
  const capsulePrefix = 'profile-capsule:';
  const primerPrefix = 'profile-primer:';
  let current: { content: string } | null;
  let expectedDigest: string;
  try {
    if (sourceRef.ref.startsWith(capsulePrefix)) {
      expectedDigest = sourceRef.ref.slice(capsulePrefix.length);
      current = input.profileRepository.readCapsule(input.userId);
    } else if (sourceRef.ref.startsWith(primerPrefix) && input.catId) {
      expectedDigest = sourceRef.ref.slice(primerPrefix.length);
      current = input.profileRepository.readPrimer(input.profileRepository.scope(input.userId, input.catId));
    } else {
      return 'unknown';
    }
  } catch {
    return 'unknown';
  }
  if (!current) return 'deleted';
  if (!KEYED_DIGEST.test(expectedDigest) || !input.keyedContentDigest) return 'unknown';
  let currentEvidence = current.content;
  if (sourceRef.ref.startsWith(capsulePrefix)) {
    try {
      currentEvidence = renderUserCapsuleSection(current.content);
    } catch {
      return 'unknown';
    }
  }
  const currentDigest = await input.keyedContentDigest(currentEvidence).catch(() => null);
  return currentDigest === expectedDigest ? 'available' : currentDigest ? 'redacted' : 'unknown';
}

async function resolveHomeStateSource(
  sourceRef: RequestGenerationSourceRef,
  input: RequestGenerationSourcePolicyInput,
): Promise<RequestGenerationSegmentState> {
  if (sourceRef.ref.startsWith('profile-')) return resolveProfileSource(sourceRef, input);
  const missionPrefix = 'thread-mission:';
  if (!sourceRef.ref.startsWith(missionPrefix)) return 'unknown';
  if (sourceRef.ref.slice(missionPrefix.length) !== input.threadId) return 'redacted';
  if (!input.threadStore) return 'unknown';
  const thread = await Promise.resolve(input.threadStore.get(input.threadId));
  if (!thread) return 'deleted';
  return thread.createdBy === input.userId || thread.id === 'default' ? 'available' : 'redacted';
}

function resolveSystemPromptSource(sourceRef: RequestGenerationSourceRef): RequestGenerationSegmentState {
  if (sourceRef.ref === 'staging:adr-038') return 'available';
  return sourceRef.ref === CAT_CAFE_SYSTEM_PROMPT_SOURCE_REF ? 'available' : 'unknown';
}

function resolveRuntimeContextSource(
  sourceRef: RequestGenerationSourceRef,
  input: RequestGenerationSourcePolicyInput,
): RequestGenerationSegmentState {
  const invocationRefs = new Set([
    `context-management-hint:${input.invocationId}`,
    `capacity-recovery:${input.invocationId}`,
  ]);
  if (invocationRefs.has(sourceRef.ref)) return 'available';
  return sourceRef.ref === `transcript-path-hints:${input.threadId}` ? 'available' : 'redacted';
}

/**
 * Resolve exact-segment visibility through existing source owners.
 *
 * The route has already established thread access. Sources without an owner
 * resolver remain typed unknown; this function never upgrades absence into
 * deletion or invents an F299-specific permission ledger.
 */
export async function resolveRequestGenerationSourceStates(
  sourceRefs: readonly RequestGenerationSourceRef[],
  input: RequestGenerationSourcePolicyInput,
): Promise<Map<string, RequestGenerationSegmentState>> {
  const states = new Map<string, RequestGenerationSegmentState>();
  for (const sourceRef of sourceRefs) {
    const key = requestGenerationSourceKey(sourceRef);
    if (states.has(key)) continue;
    let state: RequestGenerationSegmentState;
    if (sourceRef.owner === 'message') state = await resolveMessageSource(sourceRef, input);
    else if (sourceRef.owner === 'memory') state = await resolveMemorySource(sourceRef, input);
    else if (sourceRef.owner === 'home_state') state = await resolveHomeStateSource(sourceRef, input);
    else if (sourceRef.owner === 'system_prompt') state = resolveSystemPromptSource(sourceRef);
    else if (sourceRef.owner === 'runtime_context') state = resolveRuntimeContextSource(sourceRef, input);
    else state = 'unknown';
    states.set(key, state);
  }
  return states;
}
