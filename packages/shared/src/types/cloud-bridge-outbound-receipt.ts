export type CloudBridgeOutboundStatus = 'sent' | 'failed' | 'unknown';
export type CloudBridgeOutboundTransport = 'host' | 'legacy-pinchtab' | 'none';
export type CloudBridgeIdempotencyDisposition = 'fresh' | 'replayed' | 'not_attempted' | 'unknown';
const DIAGNOSTIC_FIELDS = new Set(['v', 'errorCode', 'nextAction', 'fingerprint']);
const FINGERPRINT_FIELDS = new Set([
  'v',
  'phase',
  'adapterRevision',
  'artifactRevision',
  'firstUnsupportedPath',
  'nodes',
  'truncated',
]);
const FINGERPRINT_NODE_FIELDS = new Set([
  'path',
  'kind',
  'empty',
  'tag',
  'nodeType',
  'childCount',
  'contentEditable',
  'proseMirror',
  'placeholder',
  'virtualKeyboard',
  'trailingBreak',
]);
const FINGERPRINT_PATH =
  /^composer(?:\/(?:[a-z][a-z0-9-]{0,31}|#text|#node-(?:0|[1-9]\d{0,3}))\[(?:0|[1-9]\d{0,9})\])*$/;
const MAX_FINGERPRINT_PATH_LENGTH = 512;
const MAX_DOM_CHILD_INDEX = 0xffff_ffff;

export interface CloudBridgeDomFingerprintV1 {
  readonly v: 1;
  readonly phase: string;
  readonly adapterRevision: string;
  readonly artifactRevision: string;
  readonly firstUnsupportedPath?: string;
  readonly nodes: readonly Readonly<Record<string, string | number | boolean>>[];
  readonly truncated: boolean;
}

export interface CloudBridgeFailureDiagnosticV1 {
  readonly v: 1;
  readonly errorCode: string;
  readonly nextAction: 'inspect_bound_tab';
  readonly fingerprint: CloudBridgeDomFingerprintV1;
}

/** F247: refs-only canonical thread projection for one cloud dispatch attempt. */
export interface CloudBridgeOutboundReceiptV1 {
  readonly v: 1;
  readonly sourceMessageId: string;
  readonly sourceSender: {
    readonly kind: 'cat' | 'user';
    readonly id: string;
    readonly invocationId?: string;
  };
  readonly dispatchInvocationId: string;
  readonly targetCatId: string;
  readonly status: CloudBridgeOutboundStatus;
  readonly transport: CloudBridgeOutboundTransport;
  readonly hostMessageId?: string;
  readonly failure?: CloudBridgeFailureDiagnosticV1;
  readonly idempotency: {
    readonly keyKind: 'source_message_id';
    readonly disposition: CloudBridgeIdempotencyDisposition;
  };
}

function isBoundedReceiptRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function isDiagnosticToken(value: unknown, maximum = 32): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isFingerprintPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_FINGERPRINT_PATH_LENGTH &&
    FINGERPRINT_PATH.test(value) &&
    [...value.matchAll(/\[(\d+)\]/g)].every((match) => Number(match[1]) <= MAX_DOM_CHILD_INDEX)
  );
}

function hasValidOptionalBooleans(node: Record<string, unknown>): boolean {
  return ['empty', 'contentEditable', 'proseMirror', 'placeholder', 'virtualKeyboard', 'trailingBreak'].every(
    (field) => node[field] === undefined || typeof node[field] === 'boolean',
  );
}

function hasValidOptionalIntegers(node: Record<string, unknown>): boolean {
  return (
    (node.nodeType === undefined ||
      (Number.isInteger(node.nodeType) && Number(node.nodeType) >= 0 && Number(node.nodeType) <= 1_000)) &&
    (node.childCount === undefined ||
      (Number.isInteger(node.childCount) &&
        Number(node.childCount) >= 0 &&
        Number(node.childCount) <= MAX_DOM_CHILD_INDEX))
  );
}

function isFingerprintNode(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  if (Object.keys(node).some((field) => !FINGERPRINT_NODE_FIELDS.has(field))) return false;
  if (!isFingerprintPath(node.path)) return false;
  if (!['text', 'element', 'other'].includes(String(node.kind))) return false;
  if (node.tag !== undefined && (typeof node.tag !== 'string' || !/^[A-Z][A-Z0-9-]{0,31}$/.test(node.tag))) {
    return false;
  }
  return hasValidOptionalBooleans(node) && hasValidOptionalIntegers(node);
}

export function isCloudBridgeFailureDiagnosticV1(value: unknown): value is CloudBridgeFailureDiagnosticV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const diagnostic = value as Record<string, unknown>;
  if (Object.keys(diagnostic).some((field) => !DIAGNOSTIC_FIELDS.has(field))) return false;
  if (diagnostic.v !== 1 || !/^[A-Z][A-Z0-9_]{2,63}$/.test(String(diagnostic.errorCode))) return false;
  if (diagnostic.nextAction !== 'inspect_bound_tab') return false;
  const fingerprint = diagnostic.fingerprint;
  if (typeof fingerprint !== 'object' || fingerprint === null || Array.isArray(fingerprint)) return false;
  const record = fingerprint as Record<string, unknown>;
  if (Object.keys(record).some((field) => !FINGERPRINT_FIELDS.has(field))) return false;
  if (
    record.v !== 1 ||
    !isDiagnosticToken(record.phase) ||
    !isDiagnosticToken(record.adapterRevision) ||
    !isDiagnosticToken(record.artifactRevision) ||
    typeof record.truncated !== 'boolean' ||
    !Array.isArray(record.nodes) ||
    record.nodes.length > 12
  ) {
    return false;
  }
  if (record.firstUnsupportedPath !== undefined && !isFingerprintPath(record.firstUnsupportedPath)) {
    return false;
  }
  return record.nodes.every(isFingerprintNode);
}

function isReceiptSender(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const sender = value as Record<string, unknown>;
  return (
    ['cat', 'user'].includes(String(sender.kind)) &&
    isBoundedReceiptRef(sender.id) &&
    (sender.invocationId === undefined || isBoundedReceiptRef(sender.invocationId))
  );
}

function isReceiptIdempotency(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const idempotency = value as Record<string, unknown>;
  return (
    idempotency.keyKind === 'source_message_id' &&
    ['fresh', 'replayed', 'not_attempted', 'unknown'].includes(String(idempotency.disposition))
  );
}

/** Validates the known fields; persistence still projects an explicit allowlist to discard extras. */
export function isCloudBridgeOutboundReceiptV1(value: unknown): value is CloudBridgeOutboundReceiptV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (receipt.v !== 1 || !isBoundedReceiptRef(receipt.sourceMessageId)) return false;
  if (!isBoundedReceiptRef(receipt.dispatchInvocationId) || !isBoundedReceiptRef(receipt.targetCatId)) return false;
  if (!['sent', 'failed', 'unknown'].includes(String(receipt.status))) return false;
  if (!['host', 'legacy-pinchtab', 'none'].includes(String(receipt.transport))) return false;
  if (receipt.hostMessageId !== undefined && !isBoundedReceiptRef(receipt.hostMessageId)) return false;
  if (receipt.failure !== undefined && !isCloudBridgeFailureDiagnosticV1(receipt.failure)) return false;

  return isReceiptSender(receipt.sourceSender) && isReceiptIdempotency(receipt.idempotency);
}
