/**
 * Plugin Messaging — draft/append input validation (K-1 / F288, plan Task 1)
 *
 * Fail-closed: anything not positively recognized is rejected with
 * MessagingError('VALIDATION'). Bounds per MESSAGING_BOUNDS (D-6).
 * Grant/handle semantics (instance match, whisper ⊆ grant, binding match)
 * live in send/append services — this module is pure input shape.
 */

import type {
  AppendElementsRequest,
  DraftAudience,
  DraftOrigin,
  DraftProvenance,
  ElementKind,
  EpistemicStatus,
  MessageAddress,
  MessageDraft,
  MessageElement,
  MessageHandle,
} from '@clowder-ai/plugin-contract';
import { MESSAGING_BOUNDS } from '@clowder-ai/plugin-contract';
import { MessagingError } from './host-types.js';

const EPISTEMIC_STATUSES: readonly EpistemicStatus[] = ['observation', 'user_intent', 'inference'];
const ELEMENT_KINDS: readonly ElementKind[] = ['text', 'media_ref', 'rich_block'];
const ADDRESS_KINDS = ['thread_handle', 'connector_binding'] as const;

function fail(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new MessagingError('VALIDATION', message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) fail(`${field} contains unknown properties: ${unknown.join(', ')}`);
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a non-empty string`);
  if (value.length > maxLength) fail(`${field} exceeds max length ${maxLength}`);
  return value;
}

function validateEpistemicStatus(value: unknown, field: string): EpistemicStatus {
  if (typeof value !== 'string' || !(EPISTEMIC_STATUSES as readonly string[]).includes(value)) {
    fail(`${field}.epistemicStatus must be one of ${EPISTEMIC_STATUSES.join('|')}`);
  }
  return value as EpistemicStatus;
}

function validateOrigin(value: unknown): DraftOrigin {
  if (!isRecord(value)) fail('provenance.origin must be an object when present');
  if (value.kind === 'host') fail('provenance.origin kind "host" cannot be declared by a draft (D-4)');
  if (value.kind === 'plugin') {
    rejectUnknownKeys(value, ['kind', 'instanceId'], 'provenance.origin');
    return { kind: 'plugin', instanceId: requireString(value.instanceId, 'origin.instanceId', 256) };
  }
  if (value.kind === 'external') {
    rejectUnknownKeys(value, ['kind', 'connectorId', 'sourceAddress'], 'provenance.origin');
    const connectorId = requireString(value.connectorId, 'origin.connectorId', 256);
    if (value.sourceAddress === undefined) return { kind: 'external', connectorId };
    if (!isRecord(value.sourceAddress)) fail('origin.sourceAddress must be an object when present');
    const sa = value.sourceAddress;
    rejectUnknownKeys(sa, ['connectorId', 'chatId', 'messageId'], 'origin.sourceAddress');
    return {
      kind: 'external',
      connectorId,
      sourceAddress: {
        connectorId: requireString(sa.connectorId, 'sourceAddress.connectorId', 256),
        chatId: requireString(sa.chatId, 'sourceAddress.chatId', 512),
        ...(sa.messageId !== undefined
          ? { messageId: requireString(sa.messageId, 'sourceAddress.messageId', 512) }
          : {}),
      },
    };
  }
  return fail('provenance.origin.kind must be plugin|external');
}

function payloadByteSize(payload: Record<string, unknown>, field: string): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    return fail(`${field}.payload must be JSON-serializable`);
  }
}

function validateElements(value: unknown, field: string): MessageElement[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${field}.elements must be a non-empty array`);
  if (value.length > MESSAGING_BOUNDS.maxElementsPerOperation) {
    fail(`${field}.elements exceeds max ${MESSAGING_BOUNDS.maxElementsPerOperation} per operation`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const elements: MessageElement[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) fail(`${field}.elements entries must be objects`);
    rejectUnknownKeys(
      raw,
      ['elementId', 'kind', 'payload', 'epistemicStatus', 'derivedFromElementId'],
      `${field}.element`,
    );
    const elementId = requireString(raw.elementId, 'elementId', MESSAGING_BOUNDS.maxElementIdLength);
    if (seen.has(elementId)) fail(`duplicate elementId "${elementId}"`);
    seen.add(elementId);
    if (typeof raw.kind !== 'string' || !(ELEMENT_KINDS as readonly string[]).includes(raw.kind)) {
      fail(`element kind must be one of ${ELEMENT_KINDS.join('|')}`);
    }
    const kind = raw.kind as ElementKind;
    if (!isRecord(raw.payload)) fail('element payload must be an object');
    if (kind === 'text' && typeof raw.payload.text !== 'string') {
      fail('text element payload requires a string "text" field');
    }
    if (kind === 'text') rejectUnknownKeys(raw.payload, ['text'], 'text element payload');
    const bytes = payloadByteSize(raw.payload, field);
    if (bytes > MESSAGING_BOUNDS.maxElementPayloadBytes) {
      fail(`element payload exceeds ${MESSAGING_BOUNDS.maxElementPayloadBytes} bytes`, { elementId });
    }
    totalBytes += bytes;
    // Safe assertion: runtime validation above guarantees the shape; the beta.5
    // discriminated union requires a literal `kind` that we only have as a variable.
    elements.push({
      elementId,
      kind,
      payload: raw.payload,
      ...(raw.epistemicStatus !== undefined
        ? { epistemicStatus: validateEpistemicStatus(raw.epistemicStatus, 'element') }
        : {}),
      ...(raw.derivedFromElementId !== undefined
        ? {
            derivedFromElementId: requireString(
              raw.derivedFromElementId,
              'derivedFromElementId',
              MESSAGING_BOUNDS.maxElementIdLength,
            ),
          }
        : {}),
    } as MessageElement);
  }
  if (totalBytes > MESSAGING_BOUNDS.maxTotalPayloadBytes) {
    fail(`total element payload exceeds ${MESSAGING_BOUNDS.maxTotalPayloadBytes} bytes`);
  }
  return elements;
}

function validateAddress(value: unknown): MessageAddress {
  if (!isRecord(value)) fail('address must be a host-issued handle object (no bare threadId channel)');
  rejectUnknownKeys(value, ['kind', 'handle'], 'address');
  if (typeof value.kind !== 'string' || !(ADDRESS_KINDS as readonly string[]).includes(value.kind)) {
    fail(`address.kind must be one of ${ADDRESS_KINDS.join('|')}`);
  }
  return {
    kind: value.kind as MessageAddress['kind'],
    handle: requireString(value.handle, 'address.handle', 256),
  };
}

function validateDraftAudience(value: unknown): DraftAudience | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail('draftAudience must be an object');
  if (value.kind === 'public') {
    rejectUnknownKeys(value, ['kind'], 'draftAudience');
    return { kind: 'public' };
  }
  if (value.kind === 'whisper') {
    rejectUnknownKeys(value, ['kind', 'targets'], 'draftAudience');
    if (!Array.isArray(value.targets) || value.targets.length === 0) {
      fail('whisper audience requires a non-empty targets array');
    }
    if (value.targets.length > MESSAGING_BOUNDS.maxWhisperTargets) {
      fail(`whisper targets exceed max ${MESSAGING_BOUNDS.maxWhisperTargets}`);
    }
    const targets = value.targets.map((t) => requireString(t, 'whisper target', 256));
    if (new Set(targets).size !== targets.length) fail('whisper targets contain duplicate values');
    return { kind: 'whisper', targets };
  }
  return fail('draftAudience.kind must be public|whisper (system is host-only, INV-2)');
}

function validateDraftProvenance(value: unknown): DraftProvenance {
  if (!isRecord(value)) fail('payload.provenance is required');
  rejectUnknownKeys(value, ['origin', 'epistemicStatus'], 'payload.provenance');
  return {
    epistemicStatus: validateEpistemicStatus(value.epistemicStatus, 'provenance'),
    ...(value.origin !== undefined ? { origin: validateOrigin(value.origin) } : {}),
  };
}

/** Validate an untrusted draft. Throws MessagingError('VALIDATION'); returns the typed draft. */
export function validateDraft(input: unknown): MessageDraft {
  if (!isRecord(input)) fail('draft must be an object');
  rejectUnknownKeys(
    input,
    ['address', 'draftAudience', 'idempotencyKey', 'sourceEventId', 'replyTo', 'payload'],
    'draft',
  );
  if (!isRecord(input.payload)) fail('draft.payload is required');
  rejectUnknownKeys(input.payload, ['provenance', 'elements', 'correlationId', 'causationId'], 'draft.payload');
  const audience = validateDraftAudience(input.draftAudience);
  const elements = validateElements(input.payload.elements, 'payload');
  const persistedElementIds = new Set<string>();
  for (const element of elements) {
    if (element.derivedFromElementId !== undefined && !persistedElementIds.has(element.derivedFromElementId)) {
      fail(`derivedFromElementId "${element.derivedFromElementId}" must reference an earlier element in the draft`);
    }
    persistedElementIds.add(element.elementId);
  }
  return {
    address: validateAddress(input.address),
    idempotencyKey: requireString(input.idempotencyKey, 'idempotencyKey', MESSAGING_BOUNDS.maxIdempotencyKeyLength),
    ...(audience !== undefined ? { draftAudience: audience } : {}),
    ...(input.sourceEventId !== undefined
      ? { sourceEventId: requireString(input.sourceEventId, 'sourceEventId', 512) }
      : {}),
    ...(input.replyTo !== undefined ? { replyTo: requireString(input.replyTo, 'replyTo', 256) } : {}),
    payload: {
      provenance: validateDraftProvenance(input.payload.provenance),
      elements,
      ...(input.payload.correlationId !== undefined
        ? { correlationId: requireString(input.payload.correlationId, 'correlationId', 256) }
        : {}),
      ...(input.payload.causationId !== undefined
        ? { causationId: requireString(input.payload.causationId, 'causationId', 256) }
        : {}),
    },
  };
}

function validateMessageHandle(value: unknown): MessageHandle {
  if (!isRecord(value)) fail('handle must be a host-issued message handle');
  rejectUnknownKeys(value, ['kind', 'token'], 'handle');
  if (value.kind !== 'message') fail('handle.kind must be message');
  return { kind: 'message', token: requireString(value.token, 'handle.token', 512) };
}

/** Validate an untrusted appendElements input. Structural only (message-state checks live in AppendService). */
export function validateAppendInput(input: unknown): AppendElementsRequest {
  if (!isRecord(input)) fail('append input must be an object');
  rejectUnknownKeys(input, ['handle', 'operationId', 'baseRevision', 'elements'], 'append input');
  if (input.baseRevision !== undefined) {
    if (typeof input.baseRevision !== 'number' || !Number.isInteger(input.baseRevision) || input.baseRevision < 1) {
      fail('baseRevision must be a positive integer when present');
    }
  }
  return {
    handle: validateMessageHandle(input.handle),
    operationId: requireString(input.operationId, 'operationId', MESSAGING_BOUNDS.maxIdempotencyKeyLength),
    ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision as number } : {}),
    elements: validateElements(input.elements, 'append'),
  };
}
