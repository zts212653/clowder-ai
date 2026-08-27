import { type CloudBridgeFailureDiagnosticV1, isCloudBridgeFailureDiagnosticV1 } from '@cat-cafe/shared';

export const PERSONAL_CHROME_PROTOCOL_VERSION = 2 as const;
export const PERSONAL_CHROME_EXTENSION_REVISION = '0.2.5' as const;
export const PERSONAL_CHROME_PAGE_ADAPTER_REVISION = '2026-08-27.1' as const;
export const PERSONAL_CHROME_MAX_TEXT_BYTES = 128 * 1024;
export const PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES = 256 * 1024;

const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const HELPER_ARTIFACT_REVISION = /^sha512:[a-f0-9]{128}$/;

export interface PersonalChromeRevisions {
  readonly helper: string;
  readonly extension: string;
  readonly pageAdapter: string;
}

export interface PersonalChromeAppendRequest {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'append_message';
  readonly requestId: string;
  readonly conversationId: string;
  readonly text: string;
  readonly idempotencyKey: string;
  readonly expectedRevisions: PersonalChromeRevisions;
}

export interface PersonalChromeAppendSuccess {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'append_result';
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly status: 'host_observed';
  readonly hostMessageId: string;
  readonly observedRevisions: PersonalChromeRevisions;
  readonly idempotentReplay?: boolean;
}

export interface PersonalChromeAppendFailure {
  readonly v: typeof PERSONAL_CHROME_PROTOCOL_VERSION;
  readonly kind: 'append_result';
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly status: 'failed';
  readonly errorCode: string;
  readonly observedRevisions?: PersonalChromeRevisions;
  readonly diagnostic?: CloudBridgeFailureDiagnosticV1;
  readonly idempotentReplay?: boolean;
}

export type PersonalChromeAppendResult = PersonalChromeAppendSuccess | PersonalChromeAppendFailure;

export interface PersonalChromeLocalEnvelope {
  readonly pairingSecret: string;
  readonly request: PersonalChromeAppendRequest;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  label: string,
  options: { maxLength: number; pattern?: RegExp; allowWhitespace?: boolean },
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > options.maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${options.maxLength} characters`);
  }
  if (!options.allowWhitespace && value.trim() !== value) {
    throw new Error(`${label} must not have surrounding whitespace`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw new Error(`${label} has an invalid format`);
  }
  return value;
}

function parseRevisions(value: unknown, label: string): PersonalChromeRevisions {
  const record = asRecord(value, label);
  if (Object.keys(record).some((field) => !['helper', 'extension', 'pageAdapter'].includes(field))) {
    throw new Error(`${label} contains an unknown field`);
  }
  return {
    helper: requireString(record.helper, `${label}.helper`, {
      maxLength: 135,
      pattern: HELPER_ARTIFACT_REVISION,
    }),
    extension: requireString(record.extension, `${label}.extension`, {
      maxLength: 32,
      pattern: /^\d+\.\d+\.\d+$/,
    }),
    pageAdapter: requireString(record.pageAdapter, `${label}.pageAdapter`, {
      maxLength: 32,
      pattern: SAFE_TOKEN,
    }),
  };
}

export function parsePersonalChromeAppendRequest(value: unknown): PersonalChromeAppendRequest {
  const record = asRecord(value, 'append request');
  if (record.v !== PERSONAL_CHROME_PROTOCOL_VERSION || record.kind !== 'append_message') {
    throw new Error('append request has an unsupported protocol shape');
  }
  const text = requireString(record.text, 'text', {
    maxLength: PERSONAL_CHROME_MAX_TEXT_BYTES,
    allowWhitespace: true,
  });
  if (text.trim().length === 0 || Buffer.byteLength(text, 'utf8') > PERSONAL_CHROME_MAX_TEXT_BYTES) {
    throw new Error(`text exceeds ${PERSONAL_CHROME_MAX_TEXT_BYTES} bytes`);
  }
  return {
    v: PERSONAL_CHROME_PROTOCOL_VERSION,
    kind: 'append_message',
    requestId: requireString(record.requestId, 'requestId', { maxLength: 200, pattern: SAFE_TOKEN }),
    conversationId: requireString(record.conversationId, 'conversationId', {
      maxLength: 200,
      pattern: SAFE_TOKEN,
    }),
    text,
    idempotencyKey: requireString(record.idempotencyKey, 'idempotencyKey', {
      maxLength: 512,
      pattern: SAFE_TOKEN,
    }),
    expectedRevisions: parseRevisions(record.expectedRevisions, 'expectedRevisions'),
  };
}

export function parsePersonalChromeLocalEnvelope(value: unknown): PersonalChromeLocalEnvelope {
  const record = asRecord(value, 'local envelope');
  return {
    pairingSecret: requireString(record.pairingSecret, 'pairingSecret', {
      maxLength: 512,
      allowWhitespace: false,
    }),
    request: parsePersonalChromeAppendRequest(record.request),
  };
}

export function parsePersonalChromeAppendResult(value: unknown): PersonalChromeAppendResult {
  const record = asRecord(value, 'append result');
  if (record.v !== PERSONAL_CHROME_PROTOCOL_VERSION || record.kind !== 'append_result') {
    throw new Error('append result has an unsupported protocol shape');
  }
  const base = {
    v: PERSONAL_CHROME_PROTOCOL_VERSION,
    kind: 'append_result' as const,
    requestId: requireString(record.requestId, 'requestId', { maxLength: 200, pattern: SAFE_TOKEN }),
    idempotencyKey: requireString(record.idempotencyKey, 'idempotencyKey', {
      maxLength: 512,
      pattern: SAFE_TOKEN,
    }),
  };
  if (record.status === 'host_observed') {
    return {
      ...base,
      observedRevisions: parseRevisions(record.observedRevisions, 'observedRevisions'),
      status: 'host_observed',
      hostMessageId: requireString(record.hostMessageId, 'hostMessageId', {
        maxLength: 512,
        pattern: SAFE_TOKEN,
      }),
      ...(typeof record.idempotentReplay === 'boolean' ? { idempotentReplay: record.idempotentReplay } : {}),
    };
  }
  if (record.status === 'failed') {
    return {
      ...base,
      status: 'failed',
      errorCode: requireString(record.errorCode, 'errorCode', { maxLength: 64, pattern: SAFE_ERROR_CODE }),
      ...(record.observedRevisions === undefined
        ? {}
        : { observedRevisions: parseRevisions(record.observedRevisions, 'observedRevisions') }),
      ...(isCloudBridgeFailureDiagnosticV1(record.diagnostic) ? { diagnostic: record.diagnostic } : {}),
      ...(typeof record.idempotentReplay === 'boolean' ? { idempotentReplay: record.idempotentReplay } : {}),
    };
  }
  throw new Error('append result status must be host_observed or failed');
}
