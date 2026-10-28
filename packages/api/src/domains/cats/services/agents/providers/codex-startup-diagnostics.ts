import type { CliDiagnostics, CliErrorReasonCode } from '@cat-cafe/shared';
import { codexAccountCheckCopy } from '@cat-cafe/shared';
import { sanitizeCliStderr } from '../../../../../utils/sanitize-cli-stderr.js';
import { CodexAppServerRequestError, CodexAppServerRpcError } from './codex-app-server-rpc-error.js';

type Category = NonNullable<CliDiagnostics['accountCheck']>['category'];
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function classifyAccountCheck(
  requestMethod: string | undefined,
  message: string,
  httpStatus: number | undefined,
  causeCode: string | undefined,
): Category {
  if (httpStatus === 401 || httpStatus === 403) return 'auth_rejected';
  if (
    /codex_native_account_configuration_|codex_account_|invalid.*(?:workspace|provider|routing)|(?:missing|duplicate).*workspace/i.test(
      message,
    )
  )
    return 'configuration_conflict';
  if (requestMethod !== 'account/read') return 'unknown';
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus && httpStatus >= 500) return 'upstream_error';
  if (httpStatus === 408 || /workspace routing discovery timeout/.test(message)) return 'discovery_timeout';
  if (causeCode && NETWORK_CODES.has(causeCode)) return 'network_error';
  if (/^workspace routing discovery failed[.!]?$/.test(message.trim())) return 'discovery_failed';
  return 'unknown';
}

function readHttpStatus(data: Record<string, unknown>, message: string): number | undefined {
  const explicitHttp =
    /\bHTTP(?:\/[12](?:\.\d)?)?\s+(?:status[:=]?\s*)?([45]\d\d)\b/i.exec(message)?.[1] ??
    /\b(401|403)\s+(?:Unauthorized|Forbidden)\b/i.exec(message)?.[1];
  // Named HTTP fields and an explicit HTTP message are evidence; an arbitrary `status` is not.
  const status = data.httpStatus ?? data.http_status ?? (explicitHttp ? Number(explicitHttp) : undefined);
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

/** Only explicit, same-response fields. Never mine shared stderr or infer HTTP from JSON-RPC codes. */
export function codexStartupEvidence(error: unknown) {
  const rpc = error instanceof CodexAppServerRpcError ? error : undefined;
  const request = error instanceof CodexAppServerRequestError ? error : undefined;
  const requestMethod = rpc?.method ?? request?.method;
  const data = record(rpc?.data);
  const cause = record(data.cause);
  const causeMessage =
    typeof data.cause === 'string' ? data.cause : typeof cause.message === 'string' ? cause.message : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const httpStatus = readHttpStatus(data, message);
  const nativeCode = cause.code ?? record(request?.requestCause).code;
  const causeCode =
    typeof nativeCode === 'string' && /^[A-Z][A-Z_0-9]{1,40}$/.test(nativeCode) ? nativeCode : undefined;
  const category = classifyAccountCheck(requestMethod, message, httpStatus, causeCode);
  const retryAfter = data.retryAfterMs ?? data.retry_after_ms;
  const retryAfterMs =
    typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
  const requestId = data.requestId ?? data.request_id;
  const upstreamRequestId =
    typeof requestId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)
      ? requestId
      : undefined;
  return {
    category,
    rpc,
    requestMethod,
    httpStatus,
    causeCode,
    causeMessage,
    retryAfterMs,
    upstreamRequestId,
    message,
  };
}

export function isRetryableCodexStartupError(error: unknown): boolean {
  const category = codexStartupEvidence(error).category;
  if (category === 'auth_rejected' || category === 'configuration_conflict') return false;
  // The preflight wrapper establishes phase and request ownership. A method list
  // would omit future preflight reads; provider verdicts are never wrapped.
  if (error instanceof CodexAppServerRequestError) return true;
  return ['discovery_failed', 'discovery_timeout', 'network_error', 'rate_limited', 'upstream_error'].includes(
    category,
  );
}

export function buildCodexStartupDiagnostics(
  error: unknown,
  invocationId: string,
  attempt: number,
  elapsedMs: number,
  evidenceAttempt = attempt,
): CliDiagnostics {
  const evidence = codexStartupEvidence(error);
  const { category, rpc, requestMethod, httpStatus, causeCode, upstreamRequestId } = evidence;
  const reasons: Partial<Record<Category, CliErrorReasonCode>> = {
    auth_rejected: 'auth_failed',
    configuration_conflict: 'invalid_config',
    network_error: 'network_error',
    upstream_error: 'upstream_service_error',
    rate_limited: 'server_overloaded',
  };
  const reasonCode = reasons[category];
  // Redact full private paths as well as credentials; truncate only AFTER sanitizing.
  const sanitize = (text: string, limit: number) =>
    sanitizeCliStderr(text)
      .replace(/(^|[\s("'=])(?:~?[\\/]|[A-Za-z]:[\\/])[^\s"'<>)]*/g, '$1[PATH_REDACTED]')
      .slice(0, limit);
  const causeMessage = evidence.causeMessage ? sanitize(evidence.causeMessage, 500) : undefined;
  const safeExcerpt = sanitize([evidence.message, causeMessage].filter(Boolean).join('\n'), 1500);
  const diagnostics: CliDiagnostics = {
    ...(reasonCode ? { reasonCode } : {}),
    publicSummary: '',
    publicHint: '',
    safeExcerpt,
    excerptSource: 'unknown_raw',
    debugRef: {
      command: 'codex app-server',
      signal: null,
      invocationId,
      upstreamRequestId,
    },
    accountCheck: {
      category,
      rpcMethod: requestMethod,
      rpcCode: rpc?.code,
      httpStatus,
      causeCode,
      causeMessage,
      causeProvided: Boolean(httpStatus || causeCode || causeMessage),
      attempt,
      evidenceAttempt,
      elapsedMs,
    },
  };
  const copy = codexAccountCheckCopy(diagnostics);
  return { ...diagnostics, publicSummary: copy.summary, publicHint: copy.hint };
}
