import { API_URL } from '@/utils/api-client';

type EditorBridgeOperation = 'content.load' | 'content.settle' | 'surface.fontMetric';

export interface EditorBridgeResponse {
  readonly v: 1;
  readonly kind: 'cat-cafe-content-editor-response';
  readonly sessionToken: string;
  readonly requestId: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface EditorBridgeDispatchResult {
  readonly response: EditorBridgeResponse;
  readonly transfers: Transferable[];
}

export interface EditorBridgeClientOptions {
  readonly expectedSessionToken: string;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
  readonly onUnavailable?: () => void;
}

interface ValidatedBridgeRequest {
  readonly sessionToken: string;
  readonly requestId: string;
  readonly operation: EditorBridgeOperation;
  readonly payload: Record<string, unknown>;
}

export async function dispatchEditorBridgeRequest(
  value: unknown,
  options: EditorBridgeClientOptions,
): Promise<EditorBridgeDispatchResult> {
  const envelope = readEnvelope(value);
  if (!envelope) return deniedResponse(options.expectedSessionToken, requestIdFrom(value), 'invalid_bridge_request');
  if (envelope.sessionToken !== options.expectedSessionToken) {
    return deniedResponse(options.expectedSessionToken, envelope.requestId, 'bridge_session_mismatch');
  }
  const request = validateOperation(envelope);
  if (!request) return deniedResponse(options.expectedSessionToken, envelope.requestId, 'bridge_method_denied');

  let payload: Record<string, unknown>;
  if (request.operation === 'content.load') {
    if (Object.keys(request.payload).length !== 0) {
      return deniedResponse(options.expectedSessionToken, request.requestId, 'invalid_bridge_payload');
    }
    payload = {};
  } else if (request.operation === 'content.settle') {
    const encoded = settlementPayload(request.payload);
    if (!encoded) return deniedResponse(options.expectedSessionToken, request.requestId, 'invalid_bridge_payload');
    payload = encoded;
  } else {
    const family = request.payload.family;
    if (typeof family !== 'string' || family.trim() !== family || family.length < 1 || family.length > 128) {
      return deniedResponse(options.expectedSessionToken, request.requestId, 'invalid_bridge_payload');
    }
    payload = { family };
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${options.apiBase ?? API_URL}/api/collaborative-content/editor-bridge`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        sessionToken: request.sessionToken,
        operation: request.operation,
        payload,
      }),
    });
    const body: unknown = await response.json();
    const parsed = readHostResponse(body);
    if (!parsed) return deniedResponse(options.expectedSessionToken, request.requestId, 'invalid_host_response');
    if (!response.ok || !parsed.ok) {
      return {
        response: {
          v: 1,
          kind: 'cat-cafe-content-editor-response',
          sessionToken: options.expectedSessionToken,
          requestId: request.requestId,
          ok: false,
          error: parsed.error ?? { code: 'host_bridge_failed', message: 'Host bridge request failed' },
        },
        transfers: [],
      };
    }
    if (request.operation !== 'content.load') {
      return {
        response: successResponse(options.expectedSessionToken, request.requestId, parsed.value),
        transfers: [],
      };
    }
    const loaded = decodeLoadedContent(parsed.value);
    if (!loaded) return deniedResponse(options.expectedSessionToken, request.requestId, 'invalid_host_response');
    return {
      response: successResponse(options.expectedSessionToken, request.requestId, loaded),
      transfers: [loaded.bytes],
    };
  } catch {
    return deniedResponse(options.expectedSessionToken, request.requestId, 'host_bridge_failed');
  }
}

export function attachEditorBridgePort(port: MessagePort, options: EditorBridgeClientOptions): () => void {
  let attached = true;
  const listener = (event: MessageEvent<unknown>): void => {
    void dispatchEditorBridgeRequest(event.data, options).then(({ response, transfers }) => {
      if (!attached) return;
      port.postMessage(response, transfers);
      if (!response.ok && response.error && UNAVAILABLE_ERRORS.has(response.error.code)) options.onUnavailable?.();
    });
  };
  port.addEventListener('message', listener);
  port.start();
  return () => {
    attached = false;
    port.removeEventListener('message', listener);
    port.close();
  };
}

const UNAVAILABLE_ERRORS = new Set([
  'authority_changed',
  'provider_unavailable',
  'session_revoked',
  'session_closed',
  'session_not_active',
  'session_not_found',
  'identity_required',
  'content_access_denied',
  'host_bridge_failed',
  'invalid_host_response',
]);

function readEnvelope(value: unknown): ValidatedBridgeRequest | null {
  if (!isRecord(value)) return null;
  if (
    value.v !== 1 ||
    value.kind !== 'cat-cafe-content-editor-request' ||
    typeof value.sessionToken !== 'string' ||
    typeof value.requestId !== 'string' ||
    value.requestId.length < 1 ||
    value.requestId.length > 256 ||
    typeof value.operation !== 'string' ||
    !isRecord(value.payload)
  ) {
    return null;
  }
  return {
    sessionToken: value.sessionToken,
    requestId: value.requestId,
    operation: value.operation as EditorBridgeOperation,
    payload: value.payload,
  };
}

function validateOperation(value: ValidatedBridgeRequest): ValidatedBridgeRequest | null {
  return value.operation === 'content.load' ||
    value.operation === 'content.settle' ||
    value.operation === 'surface.fontMetric'
    ? value
    : null;
}

function settlementPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (
    Object.keys(payload).length !== 3 ||
    !Number.isSafeInteger(payload.expectedOwnerRevision) ||
    Number(payload.expectedOwnerRevision) < 0 ||
    typeof payload.operationId !== 'string' ||
    payload.operationId.length < 1 ||
    payload.operationId.length > 512 ||
    !(payload.bytes instanceof ArrayBuffer)
  ) {
    return null;
  }
  return {
    expectedOwnerRevision: payload.expectedOwnerRevision,
    operationId: payload.operationId,
    bytesBase64: arrayBufferToBase64(payload.bytes),
  };
}

function readHostResponse(value: unknown): {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
} | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return null;
  if (value.ok) return { ok: true, value: value.value };
  if (!isRecord(value.error) || typeof value.error.code !== 'string') return { ok: false };
  return {
    ok: false,
    error: {
      code: value.error.code,
      message: typeof value.error.message === 'string' ? value.error.message : 'Host bridge request failed',
    },
  };
}

function decodeLoadedContent(value: unknown): {
  readonly contentIdentity: string;
  readonly fileName: string;
  readonly ownerRevision: number;
  readonly blobDigest: string;
  readonly mediaType: string;
  readonly bytes: ArrayBuffer;
} | null {
  if (
    !isRecord(value) ||
    typeof value.contentIdentity !== 'string' ||
    typeof value.fileName !== 'string' ||
    !Number.isSafeInteger(value.ownerRevision) ||
    typeof value.blobDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.blobDigest) ||
    typeof value.mediaType !== 'string' ||
    typeof value.bytesBase64 !== 'string'
  ) {
    return null;
  }
  const bytes = base64ToArrayBuffer(value.bytesBase64);
  if (!bytes) return null;
  return {
    contentIdentity: value.contentIdentity,
    fileName: value.fileName,
    ownerRevision: Number(value.ownerRevision),
    blobDigest: value.blobDigest,
    mediaType: value.mediaType,
    bytes,
  };
}

function successResponse(sessionToken: string, requestId: string, value: unknown): EditorBridgeResponse {
  return {
    v: 1,
    kind: 'cat-cafe-content-editor-response',
    sessionToken,
    requestId,
    ok: true,
    value,
  };
}

function deniedResponse(sessionToken: string, requestId: string, code: string): EditorBridgeDispatchResult {
  return {
    response: {
      v: 1,
      kind: 'cat-cafe-content-editor-response',
      sessionToken,
      requestId,
      ok: false,
      error: { code, message: 'Host bridge request denied' },
    },
    transfers: [],
  };
}

function requestIdFrom(value: unknown): string {
  return isRecord(value) && typeof value.requestId === 'string' ? value.requestId.slice(0, 256) : 'invalid-request';
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
