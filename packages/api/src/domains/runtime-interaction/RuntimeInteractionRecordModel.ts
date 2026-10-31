import { isDeepStrictEqual } from 'node:util';
import type {
  RuntimeInteractionRecord,
  RuntimeInteractionRequest,
  RuntimeInteractionReturnBinding,
  RuntimeInteractionSource,
} from '@cat-cafe/shared';
import { parseRuntimeInteractionRequest } from '@cat-cafe/shared';

export function bindingsForRuntimeInteraction(request: RuntimeInteractionRequest): {
  source: RuntimeInteractionSource;
  returnBinding: RuntimeInteractionReturnBinding;
} {
  if (request.kind === 'conversation_decision') {
    return {
      source: {
        kind: 'conversation_decision',
        requesterCatId: request.owner.catId,
        requesterThreadId: request.owner.threadId,
        requesterInvocationId: request.owner.invocationId,
      },
      returnBinding: {
        kind: 'conversation_turn',
        requesterCatId: request.owner.catId,
        requesterThreadId: request.owner.threadId,
      },
    };
  }
  return {
    source: { kind: 'provider_request', provider: structuredClone(request.provider) },
    returnBinding: { kind: 'provider_waiter' },
  };
}

export function normalizeRuntimeInteractionRecord(
  record: Omit<RuntimeInteractionRecord, 'request' | 'source' | 'returnBinding' | 'revision'> & {
    request: unknown;
    source?: RuntimeInteractionSource;
    returnBinding?: RuntimeInteractionReturnBinding;
    revision?: number;
  },
): RuntimeInteractionRecord {
  const request = parseRuntimeInteractionRequest(record.request);
  const derived = bindingsForRuntimeInteraction(request);
  const explicitRevision =
    typeof record.revision === 'number' && Number.isInteger(record.revision) && record.revision > 0
      ? record.revision
      : undefined;
  if (
    request.kind === 'conversation_decision' &&
    (!record.source || !record.returnBinding || explicitRevision === undefined)
  ) {
    throw new Error('conversation interaction requires explicit durable bindings and revision');
  }
  const source = record.source ?? derived.source;
  const returnBinding = record.returnBinding ?? derived.returnBinding;
  if (!bindingsMatch(request, source, returnBinding)) {
    throw new Error('runtime interaction source/return binding does not match its canonical request');
  }
  const revision = explicitRevision ?? 1;
  return {
    ...record,
    request,
    source,
    returnBinding,
    revision,
  };
}

function bindingsMatch(
  request: RuntimeInteractionRequest,
  source: RuntimeInteractionSource,
  returnBinding: RuntimeInteractionReturnBinding,
): boolean {
  if (request.kind === 'conversation_decision') {
    return (
      source.kind === 'conversation_decision' &&
      source.requesterCatId === request.owner.catId &&
      source.requesterThreadId === request.owner.threadId &&
      source.requesterInvocationId === request.owner.invocationId &&
      returnBinding.kind === 'conversation_turn' &&
      returnBinding.requesterCatId === request.owner.catId &&
      returnBinding.requesterThreadId === request.owner.threadId
    );
  }
  return (
    source.kind === 'provider_request' &&
    isDeepStrictEqual(source.provider, request.provider) &&
    returnBinding.kind === 'provider_waiter'
  );
}

export function isRuntimeInteractionActive(record: RuntimeInteractionRecord): boolean {
  return record.status === 'staged' || record.status === 'pending';
}

export function isConversationRuntimeInteraction(record: RuntimeInteractionRecord): boolean {
  return record.source.kind === 'conversation_decision' && record.returnBinding.kind === 'conversation_turn';
}

export function isProviderRuntimeInteraction(record: RuntimeInteractionRecord): boolean {
  return record.source.kind === 'provider_request' && record.returnBinding.kind === 'provider_waiter';
}
