const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const APPEND_PROTOCOL_VERSION = 2;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const HELPER_REVISION = /^sha512:[a-f0-9]{128}$/;
const EXTENSION_REVISION = /^\d+\.\d+\.\d+$/;
const FINGERPRINT_PATH =
  /^composer(?:\/(?:[a-z][a-z0-9-]{0,31}|#text|#node-(?:0|[1-9]\d{0,3}))\[(?:0|[1-9]\d{0,9})\])*$/;
const MAX_FINGERPRINT_PATH_LENGTH = 512;
const MAX_DOM_CHILD_INDEX = 0xffff_ffff;
const DIAGNOSTIC_FIELDS = new Set(['v', 'errorCode', 'fingerprint', 'nextAction']);
const FINGERPRINT_FIELDS = new Set([
  'v',
  'phase',
  'adapterRevision',
  'artifactRevision',
  'nodes',
  'truncated',
  'firstUnsupportedPath',
]);
const NODE_FIELDS = new Set([
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

export function safeToken(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && SAFE_TOKEN.test(value);
}

export function safeErrorCode(value) {
  return typeof value === 'string' && SAFE_ERROR_CODE.test(value);
}

function safeFingerprintPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_FINGERPRINT_PATH_LENGTH &&
    FINGERPRINT_PATH.test(value) &&
    [...value.matchAll(/\[(\d+)\]/g)].every((match) => Number(match[1]) <= MAX_DOM_CHILD_INDEX)
  );
}

export function safeRevisions(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (Object.keys(value).some((field) => !['helper', 'extension', 'pageAdapter'].includes(field))) return null;
  if (!HELPER_REVISION.test(value.helper) || !EXTENSION_REVISION.test(value.extension)) return null;
  if (!safeToken(value.pageAdapter, 32)) return null;
  return { helper: value.helper, extension: value.extension, pageAdapter: value.pageAdapter };
}

function copyBooleanFields(value, sanitized) {
  for (const field of ['empty', 'contentEditable', 'proseMirror', 'placeholder', 'virtualKeyboard', 'trailingBreak']) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'boolean') return false;
    sanitized[field] = value[field];
  }
  return true;
}

function copyIntegerFields(value, sanitized) {
  if (value.nodeType !== undefined) {
    if (!Number.isInteger(value.nodeType) || value.nodeType < 0 || value.nodeType > 1_000) return false;
    sanitized.nodeType = value.nodeType;
  }
  if (value.childCount !== undefined) {
    if (!Number.isInteger(value.childCount) || value.childCount < 0 || value.childCount > MAX_DOM_CHILD_INDEX) {
      return false;
    }
    sanitized.childCount = value.childCount;
  }
  return true;
}

function safeFingerprintNode(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (Object.keys(value).some((field) => !NODE_FIELDS.has(field)) || !safeFingerprintPath(value.path)) return null;
  if (value.kind !== 'text' && value.kind !== 'element' && value.kind !== 'other') return null;
  const sanitized = { path: value.path, kind: value.kind };
  if (!copyBooleanFields(value, sanitized)) return null;
  if (value.tag !== undefined) {
    if (typeof value.tag !== 'string' || !/^[A-Z][A-Z0-9-]{0,31}$/.test(value.tag)) return null;
    sanitized.tag = value.tag;
  }
  if (!copyIntegerFields(value, sanitized)) return null;
  return sanitized;
}

export function safeAdapterDiagnostic(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (Object.keys(value).some((field) => !DIAGNOSTIC_FIELDS.has(field))) return null;
  if (value.v !== 1 || !safeErrorCode(value.errorCode) || value.nextAction !== 'inspect_bound_tab') return null;
  const fingerprint = value.fingerprint;
  if (typeof fingerprint !== 'object' || fingerprint === null || Array.isArray(fingerprint)) return null;
  if (Object.keys(fingerprint).some((field) => !FINGERPRINT_FIELDS.has(field))) return null;
  if (
    fingerprint.v !== 1 ||
    !safeToken(fingerprint.phase, 32) ||
    !safeToken(fingerprint.adapterRevision, 32) ||
    !safeToken(fingerprint.artifactRevision, 32) ||
    typeof fingerprint.truncated !== 'boolean' ||
    !Array.isArray(fingerprint.nodes) ||
    fingerprint.nodes.length > 12 ||
    (fingerprint.firstUnsupportedPath !== undefined && !safeFingerprintPath(fingerprint.firstUnsupportedPath))
  ) {
    return null;
  }
  const nodes = fingerprint.nodes.map(safeFingerprintNode);
  if (nodes.some((node) => node === null)) return null;
  return {
    v: 1,
    errorCode: value.errorCode,
    nextAction: value.nextAction,
    fingerprint: {
      v: 1,
      phase: fingerprint.phase,
      adapterRevision: fingerprint.adapterRevision,
      artifactRevision: fingerprint.artifactRevision,
      nodes,
      truncated: fingerprint.truncated,
      ...(fingerprint.firstUnsupportedPath === undefined
        ? {}
        : { firstUnsupportedPath: fingerprint.firstUnsupportedPath }),
    },
  };
}

export function failureFor(request, errorCode, details = {}) {
  const observedRevisions = safeRevisions(details.observedRevisions);
  const diagnostic = safeAdapterDiagnostic(details.diagnostic);
  return {
    v: APPEND_PROTOCOL_VERSION,
    kind: 'append_result',
    requestId: safeToken(request?.requestId, 200) ? request.requestId : 'invalid-request',
    idempotencyKey: safeToken(request?.idempotencyKey, 512) ? request.idempotencyKey : 'invalid-key',
    status: 'failed',
    errorCode,
    ...(observedRevisions ? { observedRevisions } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

export function terminalResult(entry, requestId, idempotentReplay = false) {
  if (entry.state === 'host_observed') {
    return {
      v: APPEND_PROTOCOL_VERSION,
      kind: 'append_result',
      requestId,
      idempotencyKey: entry.idempotencyKey,
      status: 'host_observed',
      hostMessageId: entry.hostMessageId,
      ...(entry.observedRevisions ? { observedRevisions: entry.observedRevisions } : {}),
      idempotentReplay,
    };
  }
  return {
    v: APPEND_PROTOCOL_VERSION,
    kind: 'append_result',
    requestId,
    idempotencyKey: entry.idempotencyKey,
    status: 'failed',
    errorCode: entry.errorCode,
    ...(entry.observedRevisions ? { observedRevisions: entry.observedRevisions } : {}),
    ...(entry.diagnostic ? { diagnostic: entry.diagnostic } : {}),
    idempotentReplay,
  };
}

export function applyTerminalResult(entry, result) {
  if (result.status === 'host_observed' && safeToken(result.hostMessageId, 512)) {
    entry.state = 'host_observed';
    entry.hostMessageId = result.hostMessageId;
    const observedRevisions = safeRevisions(result.observedRevisions);
    if (observedRevisions) entry.observedRevisions = observedRevisions;
    delete entry.errorCode;
    return;
  }
  entry.state = 'failed';
  entry.errorCode =
    result.status === 'host_observed'
      ? 'INVALID_HOST_RECEIPT'
      : safeErrorCode(result.errorCode)
        ? result.errorCode
        : 'NATIVE_DELIVERY_FAILED';
  delete entry.hostMessageId;
  const observedRevisions = safeRevisions(result.observedRevisions);
  const diagnostic = safeAdapterDiagnostic(result.diagnostic);
  if (observedRevisions) entry.observedRevisions = observedRevisions;
  else delete entry.observedRevisions;
  if (diagnostic) entry.diagnostic = diagnostic;
  else delete entry.diagnostic;
}
