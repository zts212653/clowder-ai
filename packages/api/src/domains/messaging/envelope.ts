/**
 * Plugin Messaging — envelope pure projection (K-1 / F288, D-1)
 *
 * MessageEnvelope is a PROJECTION of StoredMessage — the message store stays
 * the single truth source (P4); no second envelope store exists. Plugin-sent
 * messages carry their canonical payload in extra.pluginMessage; user/cat
 * messages project deterministically (snapshot support).
 *
 * Epistemic mapping for host-relayed messages (C-1 alignment point):
 * user → user_intent, cat → inference, origin always { kind: 'host' }.
 */

import type {
  CanonicalAudience,
  EpistemicStatus,
  MessageElement,
  MessageEnvelope,
  MessageProvenance,
} from '@clowder-ai/plugin-contract';
import { isWireUInt53, MESSAGING_BOUNDS, validateMessagingRowResult } from '@clowder-ai/plugin-contract';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { isBoundedScalarString } from './contract/source-admission.js';

/** One applied append operation — the INV-12 replay guard AND replay reconstruction source. */
export interface AppendOpRecord {
  readonly operationId: string;
  /** elementIds this operation appended — replays rebuild receipts/events from the PERSISTED elements. */
  readonly elementIds: readonly string[];
  /** Original concurrency precondition; deterministic eventId must always reproduce identical event content. */
  readonly baseRevision?: number;
}

/** Strict shape written into StoredMessage.extra.pluginMessage by SendService/AppendService. */
export interface PluginMessageExtra {
  readonly instanceId: string;
  readonly revision: number;
  readonly provenance: MessageProvenance;
  readonly elements: readonly MessageElement[];
  /** External source provenance retained for audit; never used as the send idempotency key. */
  readonly sourceEventId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  /** Latest message revision fully represented in the public output log. */
  readonly outputRevision?: number;
  /** Sequence of the output event that completed outputRevision. */
  readonly outputSequence?: number;
  /** Applied operations in application order — INV-12 replay guard inside the append lock. */
  readonly appendOps: readonly AppendOpRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return isBoundedScalarString(value, maxLength);
}

function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedString(value, maxLength);
}

function isEpistemicStatus(value: unknown): boolean {
  return value === 'observation' || value === 'user_intent' || value === 'inference';
}

function isOrigin(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'host') return hasOnlyKeys(value, ['kind']);
  if (value.kind === 'plugin') {
    return hasOnlyKeys(value, ['kind', 'instanceId']) && isBoundedString(value.instanceId, 256);
  }
  if (
    value.kind !== 'external' ||
    !hasOnlyKeys(value, ['kind', 'connectorId', 'sourceAddress']) ||
    !isBoundedString(value.connectorId, 256)
  ) {
    return false;
  }
  if (value.sourceAddress === undefined) return true;
  if (!isRecord(value.sourceAddress)) return false;
  return (
    hasOnlyKeys(value.sourceAddress, ['connectorId', 'chatId', 'messageId']) &&
    isBoundedString(value.sourceAddress.connectorId, 256) &&
    isBoundedString(value.sourceAddress.chatId, 512) &&
    isOptionalBoundedString(value.sourceAddress.messageId, 512)
  );
}

function isProvenance(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['origin', 'epistemicStatus']) &&
    isOrigin(value.origin) &&
    isEpistemicStatus(value.epistemicStatus)
  );
}

function payloadBytes(value: Record<string, unknown>): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return null;
  }
}

function isElement(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['elementId', 'kind', 'payload', 'epistemicStatus', 'derivedFromElementId']) ||
    !isBoundedString(value.elementId, MESSAGING_BOUNDS.maxElementIdLength)
  ) {
    return false;
  }
  if (value.kind !== 'text' && value.kind !== 'media_ref' && value.kind !== 'rich_block') return false;
  if (!isRecord(value.payload)) return false;
  if (value.kind === 'text' && (!hasOnlyKeys(value.payload, ['text']) || typeof value.payload.text !== 'string')) {
    return false;
  }
  const bytes = payloadBytes(value.payload);
  if (bytes === null || bytes > MESSAGING_BOUNDS.maxElementPayloadBytes) return false;
  if (value.epistemicStatus !== undefined && !isEpistemicStatus(value.epistemicStatus)) return false;
  return isOptionalBoundedString(value.derivedFromElementId, MESSAGING_BOUNDS.maxElementIdLength);
}

function isAppendOp(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['operationId', 'elementIds', 'baseRevision']) ||
    !isBoundedString(value.operationId, MESSAGING_BOUNDS.maxIdempotencyKeyLength) ||
    !Array.isArray(value.elementIds) ||
    value.elementIds.length === 0 ||
    !value.elementIds.every((elementId) => isBoundedString(elementId, MESSAGING_BOUNDS.maxElementIdLength)) ||
    new Set(value.elementIds).size !== value.elementIds.length
  ) {
    return false;
  }
  return (
    value.baseRevision === undefined || (typeof value.baseRevision === 'number' && isWireUInt53(value.baseRevision, 1))
  );
}

function hasValidOutputWatermark(raw: Record<string, unknown>, revision: number): boolean {
  const outputRevision = raw.outputRevision;
  const outputSequence = raw.outputSequence;
  if (outputRevision === undefined || outputSequence === undefined) {
    return outputRevision === undefined && outputSequence === undefined;
  }
  return (
    typeof outputRevision === 'number' &&
    isWireUInt53(outputRevision, 1) &&
    outputRevision <= revision &&
    typeof outputSequence === 'number' &&
    isWireUInt53(outputSequence, 1)
  );
}

const PLUGIN_MESSAGE_EXTRA_KEYS = [
  'instanceId',
  'revision',
  'provenance',
  'elements',
  'sourceEventId',
  'correlationId',
  'causationId',
  'outputRevision',
  'outputSequence',
  'appendOps',
] as const;

function hasValidElements(raw: Record<string, unknown>): raw is Record<string, unknown> & {
  readonly elements: Array<Record<string, unknown>>;
} {
  if (
    !Array.isArray(raw.elements) ||
    raw.elements.length === 0 ||
    raw.elements.length > MESSAGING_BOUNDS.maxElementsPerMessage ||
    !raw.elements.every(isElement)
  ) {
    return false;
  }

  const seenElementIds = new Set<string>();
  let totalBytes = 0;
  for (const element of raw.elements as Array<Record<string, unknown>>) {
    const elementId = element.elementId as string;
    if (seenElementIds.has(elementId)) return false;
    if (element.derivedFromElementId !== undefined && !seenElementIds.has(element.derivedFromElementId as string)) {
      return false;
    }
    seenElementIds.add(elementId);
    totalBytes += payloadBytes(element.payload as Record<string, unknown>) ?? Number.POSITIVE_INFINITY;
  }
  return totalBytes <= MESSAGING_BOUNDS.maxTotalPayloadBytes;
}

function hasValidAppendHistory(
  raw: Record<string, unknown>,
  revision: number,
  elements: Array<Record<string, unknown>>,
  messageStatus: EpistemicStatus,
): raw is Record<string, unknown> & { readonly appendOps: Array<Record<string, unknown>> } {
  if (
    !Array.isArray(raw.appendOps) ||
    raw.appendOps.length > MESSAGING_BOUNDS.maxAppendOpsPerMessage ||
    !raw.appendOps.every(isAppendOp) ||
    revision !== raw.appendOps.length + 1
  ) {
    return false;
  }

  const appendedElementCount = raw.appendOps.reduce(
    (count, record) => count + ((record as Record<string, unknown>).elementIds as string[]).length,
    0,
  );
  const suffixStart = elements.length - appendedElementCount;
  if (suffixStart < 1) return false;

  const elementIndexById = new Map(elements.map((element, index) => [element.elementId as string, index]));
  const operationIds = new Set<string>();
  let elementIndex = suffixStart;
  for (let index = 0; index < raw.appendOps.length; index += 1) {
    const record = raw.appendOps[index] as Record<string, unknown>;
    const operationId = record.operationId as string;
    const producedRevision = index + 2;
    if (operationIds.has(operationId)) return false;
    operationIds.add(operationId);
    if (record.baseRevision !== undefined && record.baseRevision !== producedRevision - 1) return false;
    const operationStart = elementIndex;
    for (const elementId of record.elementIds as string[]) {
      const element = elements[elementIndex];
      if (!element || element.elementId !== elementId || element.epistemicStatus === undefined) return false;
      const sourceId = element.derivedFromElementId as string | undefined;
      const sourceIndex = sourceId === undefined ? undefined : elementIndexById.get(sourceId);
      if (sourceIndex !== undefined && sourceIndex >= operationStart) return false;
      const status = element.epistemicStatus as EpistemicStatus;
      if (status !== 'inference') {
        if (sourceIndex === undefined) return false;
        const source = elements[sourceIndex] as Record<string, unknown>;
        if ((source.epistemicStatus ?? messageStatus) !== status) return false;
      }
      elementIndex += 1;
    }
  }
  return elementIndex === elements.length;
}

function hasValidOptionalMetadata(raw: Record<string, unknown>): boolean {
  return (
    isOptionalBoundedString(raw.sourceEventId, 512) &&
    isOptionalBoundedString(raw.correlationId, 256) &&
    isOptionalBoundedString(raw.causationId, 256)
  );
}

/**
 * Reuse the published beta.11 result validator as the canonical JSON-scalar
 * tree boundary for historical payloads. This intentionally validates a
 * snapshot envelope rather than a send draft: persisted messages may contain
 * up to 128 cumulative elements, while one send operation is capped at 32.
 */
function hasContractValidPayload(raw: Record<string, unknown>): boolean {
  const validation = validateMessagingRowResult('messaging.snapshot', {
    items: [
      {
        messageId: 'historical-validation',
        revision: raw.revision,
        threadId: 'historical-validation',
        actor: { kind: 'plugin', id: raw.instanceId },
        audience: { kind: 'public' },
        occurredAt: '2026-01-01T00:00:00.000Z',
        payload: {
          provenance: raw.provenance,
          elements: raw.elements,
          ...(raw.correlationId === undefined ? {} : { correlationId: raw.correlationId }),
          ...(raw.causationId === undefined ? {} : { causationId: raw.causationId }),
        },
      },
    ],
    nextPageToken: null,
    snapshotAckToken: 'historical-validation',
  });
  return validation.valid;
}

/** Single strict parser shared by memory projection and Redis hydration. */
export function parsePluginMessageExtra(raw: unknown): PluginMessageExtra | null {
  if (!isRecord(raw)) return null;
  if (!hasOnlyKeys(raw, PLUGIN_MESSAGE_EXTRA_KEYS)) return null;
  if (!isBoundedString(raw.instanceId, 256)) return null;
  if (typeof raw.revision !== 'number' || !isWireUInt53(raw.revision, 1)) return null;
  if (!isProvenance(raw.provenance)) return null;
  if (!hasValidElements(raw)) return null;
  const messageStatus = (raw.provenance as Record<string, unknown>).epistemicStatus as EpistemicStatus;
  if (!hasValidAppendHistory(raw, raw.revision, raw.elements, messageStatus)) return null;
  if (!hasValidOptionalMetadata(raw)) return null;
  if (!hasValidOutputWatermark(raw, raw.revision)) return null;
  if (!hasContractValidPayload(raw)) return null;
  return raw as unknown as PluginMessageExtra;
}

/** Runtime narrowing for extra.pluginMessage (fail-closed: malformed → null). */
export function readPluginMessageExtra(msg: StoredMessage): PluginMessageExtra | null {
  return parsePluginMessageExtra(msg.extra?.pluginMessage);
}

function audienceOf(msg: StoredMessage): CanonicalAudience {
  if (msg.visibility === 'whisper') {
    return { kind: 'whisper', targets: [...(msg.whisperTo ?? [])] };
  }
  return { kind: 'public' };
}

function hostRelayedEpistemic(msg: StoredMessage): EpistemicStatus {
  return msg.catId === null ? 'user_intent' : 'inference';
}

/**
 * Project a stored message to its canonical envelope.
 * Returns null for deleted/tombstoned messages and for malformed plugin extras.
 */
export function projectEnvelope(msg: StoredMessage): MessageEnvelope | null {
  if (msg.deletedAt !== undefined || msg._tombstone) return null;

  let occurredAt: string;
  try {
    occurredAt = new Date(msg.timestamp).toISOString();
  } catch {
    return null;
  }

  const base = {
    messageId: msg.id,
    threadId: msg.threadId,
    audience: audienceOf(msg),
    occurredAt,
    ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}),
  };

  if (msg.extra?.pluginMessage !== undefined) {
    const plugin = readPluginMessageExtra(msg);
    if (!plugin) return null; // fail-closed: malformed plugin payloads never project
    return {
      ...base,
      revision: plugin.revision,
      actor: { kind: 'plugin', id: plugin.instanceId },
      payload: {
        provenance: plugin.provenance,
        elements: plugin.elements,
        ...(plugin.correlationId !== undefined ? { correlationId: plugin.correlationId } : {}),
        ...(plugin.causationId !== undefined ? { causationId: plugin.causationId } : {}),
      },
    };
  }

  return {
    ...base,
    revision: 1,
    actor: msg.catId === null ? { kind: 'user', id: msg.userId } : { kind: 'cat', id: msg.catId },
    payload: {
      provenance: { origin: { kind: 'host' }, epistemicStatus: hostRelayedEpistemic(msg) },
      elements: [{ elementId: `el_${msg.id}_0`, kind: 'text', payload: { text: msg.content } }],
    },
  };
}

/** Render draft elements to the plain-text content column (Hub display, D-1). */
export function renderElementsText(elements: readonly MessageElement[]): string {
  const parts: string[] = [];
  for (const el of elements) {
    if (el.kind === 'text' && typeof el.payload.text === 'string') {
      parts.push(el.payload.text);
    } else {
      parts.push(`[${el.kind}:${el.elementId}]`);
    }
  }
  return parts.join('\n');
}
