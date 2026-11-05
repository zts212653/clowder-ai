import { buildCallbackPostMessageIdempotencyKey } from '../cats/services/agents/routing/callback-message-idempotency.js';
import { type IMessageStore, isDelivered, type StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

// Before the durable callback index cutover, ordinary callback Messages kept only their
// authenticated turn identity. Recovery may inspect that legacy history, but never without a raw-row ceiling.
const LEGACY_SOURCE_PAGE_SIZE = 200;
const LEGACY_SOURCE_SCAN_LIMIT = 5_000;

export type OrphanCarrierSourceIdentity =
  | { readonly kind: 'indexed'; readonly idempotencyKey: string }
  | {
      readonly kind: 'legacy_callback';
      readonly idempotencyKey: string;
      readonly sourceInvocationId: string;
    };

export type OrphanCarrierSourceResolution =
  | {
      readonly ok: true;
      readonly source: StoredMessage;
      readonly identity: OrphanCarrierSourceIdentity;
    }
  | {
      readonly ok: false;
      readonly reason: 'source_unreadable' | 'source_ambiguous' | 'source_scan_incomplete';
    };

type SourceMessageStore = Pick<IMessageStore, 'getByIdempotencyKey' | 'getByThreadBeforeBounded'>;

interface SourceCoordinates {
  readonly prefix: 'post:' | 'cross-post:';
  readonly clientMessageId: string;
  readonly idempotencyKey: string;
  readonly holderCatId: string;
}

function sourceCoordinates(lease: ActionSuccessorLease, dispatchId: string): SourceCoordinates | null {
  const prefix = lease.predecessorThreadId === lease.holderThreadId ? 'post:' : 'cross-post:';
  if (!dispatchId.startsWith(prefix) || !lease.predecessorCatId) return null;
  const clientMessageId = dispatchId.slice(prefix.length);
  const holderCatId = lease.holderCatIds[0];
  if (!clientMessageId || !holderCatId) return null;
  return {
    prefix,
    clientMessageId,
    holderCatId,
    idempotencyKey: buildCallbackPostMessageIdempotencyKey(lease.predecessorCatId, clientMessageId),
  };
}

function sourceMatchesLease(
  source: StoredMessage,
  lease: ActionSuccessorLease,
  coordinates: SourceCoordinates,
  input: { readonly lifecycle: 'unbound' | 'bound'; readonly expectedMessageId?: string },
): boolean {
  const crossPostMatches =
    coordinates.prefix === 'post:' || source.extra?.crossPost?.sourceThreadId === lease.predecessorThreadId;
  return (
    source.userId === lease.tenantScope &&
    source.threadId === lease.holderThreadId &&
    (!input.expectedMessageId || source.id === input.expectedMessageId) &&
    source.from?.kind === 'agent' &&
    source.from.catId === lease.predecessorCatId &&
    source.origin === 'callback' &&
    isDelivered(source) &&
    Number.isFinite(source.deliveredAt) &&
    (input.lifecycle === 'unbound' ? source.lifecycle === undefined : source.lifecycle !== undefined) &&
    !source.deletedAt &&
    !source._tombstone &&
    !source.recall &&
    source.mentions.length === 1 &&
    source.mentions[0] === coordinates.holderCatId &&
    crossPostMatches
  );
}

function callbackInvocationIdForDispatch(lease: ActionSuccessorLease, clientMessageId: string): string | null {
  const suffix = `:${clientMessageId}`;
  const candidates = new Set<string>();
  for (const evidenceRef of [lease.issuerStandingEvidenceRef, ...lease.evidenceRefs]) {
    if (!evidenceRef.startsWith('callback:') || !evidenceRef.endsWith(suffix)) continue;
    const invocationId = evidenceRef.slice('callback:'.length, -suffix.length);
    if (invocationId) candidates.add(invocationId);
  }
  return candidates.size === 1 ? (candidates.values().next().value ?? null) : null;
}

function legacySourceMatchesInvocation(
  source: StoredMessage,
  lease: ActionSuccessorLease,
  coordinates: SourceCoordinates,
  sourceInvocationId: string,
): boolean {
  // The lease is committed before its callback Message. Older speech from the same turn cannot be its carrier.
  if (!Number.isFinite(source.timestamp) || source.timestamp < lease.updatedAt) return false;
  if (source.extra?.stream?.turnInvocationId !== sourceInvocationId) return false;
  if (source.extra?.turnExecution?.invocationId !== sourceInvocationId) return false;
  if (coordinates.prefix === 'cross-post:' && source.extra?.crossPost?.sourceInvocationId !== sourceInvocationId) {
    return false;
  }
  const coordinationSubjectRef = source.extra?.coordination?.subjectRef;
  return !coordinationSubjectRef || coordinationSubjectRef === lease.subjectRef;
}

type LegacySourceScan =
  | { readonly kind: 'complete'; readonly candidates: Map<string, StoredMessage> }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'incomplete' };

async function scanLegacySourceCandidates(
  messages: SourceMessageStore,
  lease: ActionSuccessorLease,
  matches: (source: StoredMessage) => boolean,
): Promise<LegacySourceScan> {
  const candidates = new Map<string, StoredMessage>();
  let cursor: { timestamp: number; id: string } | undefined;
  let scanned = 0;
  while (scanned < LEGACY_SOURCE_SCAN_LIMIT) {
    const pageBudget = Math.min(LEGACY_SOURCE_PAGE_SIZE, LEGACY_SOURCE_SCAN_LIMIT - scanned);
    const page = await messages.getByThreadBeforeBounded(
      lease.holderThreadId,
      cursor?.timestamp ?? Number.MAX_SAFE_INTEGER,
      pageBudget,
      cursor?.id,
      lease.tenantScope,
      pageBudget,
      { includeQueuedCatMessages: true, includeQueuedUserMessages: true },
    );
    scanned += page.scannedCount;
    for (const source of page.messages.filter(matches)) candidates.set(source.id, source);
    if (candidates.size > 1) return { kind: 'ambiguous' };

    const nextCursor = page.nextCursor;
    if (page.exhausted || (nextCursor && nextCursor.timestamp < lease.updatedAt)) {
      return { kind: 'complete', candidates };
    }
    if (!nextCursor || page.scannedCount === 0) return { kind: 'incomplete' };
    cursor = nextCursor;
  }
  return { kind: 'incomplete' };
}

async function readLegacySource(
  messages: SourceMessageStore,
  lease: ActionSuccessorLease,
  coordinates: SourceCoordinates,
  input: { readonly lifecycle: 'unbound' | 'bound'; readonly expectedMessageId?: string },
): Promise<OrphanCarrierSourceResolution> {
  const sourceInvocationId = callbackInvocationIdForDispatch(lease, coordinates.clientMessageId);
  if (!sourceInvocationId) return { ok: false, reason: 'source_unreadable' };

  let scan: LegacySourceScan;
  try {
    scan = await scanLegacySourceCandidates(messages, lease, (source) =>
      Boolean(
        sourceMatchesLease(source, lease, coordinates, input) &&
          legacySourceMatchesInvocation(source, lease, coordinates, sourceInvocationId),
      ),
    );
  } catch {
    return { ok: false, reason: 'source_unreadable' };
  }

  if (scan.kind === 'ambiguous') return { ok: false, reason: 'source_ambiguous' };
  if (scan.kind === 'incomplete') return { ok: false, reason: 'source_scan_incomplete' };
  const source = scan.candidates.values().next().value;
  return source
    ? {
        ok: true,
        source,
        identity: {
          kind: 'legacy_callback',
          idempotencyKey: coordinates.idempotencyKey,
          sourceInvocationId,
        },
      }
    : { ok: false, reason: 'source_unreadable' };
}

export async function resolveOrphanCarrierSource(
  messages: SourceMessageStore,
  lease: ActionSuccessorLease,
  input: {
    readonly dispatchId: string;
    readonly lifecycle: 'unbound' | 'bound';
    readonly expectedMessageId?: string;
  },
): Promise<OrphanCarrierSourceResolution> {
  const coordinates = sourceCoordinates(lease, input.dispatchId);
  if (!coordinates) return { ok: false, reason: 'source_unreadable' };

  let indexed: StoredMessage | null;
  try {
    indexed = await messages.getByIdempotencyKey(lease.tenantScope, lease.holderThreadId, coordinates.idempotencyKey);
  } catch {
    return { ok: false, reason: 'source_unreadable' };
  }
  if (indexed) {
    return sourceMatchesLease(indexed, lease, coordinates, input)
      ? {
          ok: true,
          source: indexed,
          identity: { kind: 'indexed', idempotencyKey: coordinates.idempotencyKey },
        }
      : { ok: false, reason: 'source_unreadable' };
  }
  return readLegacySource(messages, lease, coordinates, input);
}
