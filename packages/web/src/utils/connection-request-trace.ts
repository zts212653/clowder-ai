import {
  CLIENT_REQUEST_DIAGNOSTIC_HEADER,
  type ConnectionDiagnosticEvent,
  connectionDiagnosticRoute,
} from '@cat-cafe/shared';
import { boundedFetch } from './bounded-fetch';
import {
  connectionDiagnosticId,
  recordConnectionDiagnostic,
  scheduleConnectionDiagnosticDelivery,
} from './connection-diagnostics';

type Http = Extract<ConnectionDiagnosticEvent, { kind: 'http' }>;
type Coordinate = Pick<Http, 'clientRequestId' | 'route'>;
const failures = new WeakMap<object, Coordinate>();
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function failureKind(error: unknown): NonNullable<Http['errorKind']> {
  if (!(error instanceof Error)) return 'other';
  switch (error.name) {
    case 'TimeoutError':
      return 'timeout';
    case 'AbortError':
      return 'aborted';
    case 'TypeError':
      return 'network';
    default:
      return 'other';
  }
}

export function recordConnectionNotice(error: Error, shown: boolean): void {
  recordConnectionDiagnostic({
    kind: 'connection_notice',
    ...failures.get(error),
    state: shown ? 'shown' : 'suppressed',
    errorKind: error.name === 'TimeoutError' ? 'timeout' : 'network',
  });
}

/** Called only after GET coordination, once per physical request (including a fresh 401 attempt). */
export async function diagnosticFetch(
  apiUrl: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const clientRequestId = connectionDiagnosticId();
  const headers = new Headers(init.headers);
  headers.set(CLIENT_REQUEST_DIAGNOSTIC_HEADER, clientRequestId);
  const method = (init.method ?? 'GET').toUpperCase();
  const route = connectionDiagnosticRoute(path);
  const coordinate = { clientRequestId, route };
  const common = {
    kind: 'http' as const,
    ...coordinate,
    method: (methods.has(method) ? method : 'OTHER') as Http['method'],
    deadlineMs: timeoutMs,
  };
  const started = performance.now();
  const followThrough = (route === 'messages' && method === 'POST') || route === 'navigation_source';
  if (followThrough) recordConnectionDiagnostic({ ...common, state: 'start' });
  try {
    const response = await boundedFetch(
      `${apiUrl}${path}`,
      { ...init, headers: Object.fromEntries(headers) },
      timeoutMs,
    );
    const durationMs = Math.round(performance.now() - started);
    if (followThrough || durationMs >= 1_000 || !response.ok) {
      recordConnectionDiagnostic({ ...common, state: 'finish', durationMs, statusCode: response.status });
    }
    scheduleConnectionDiagnosticDelivery();
    return response;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const errorKind = failureKind(error);
    if (error instanceof Object) failures.set(error, coordinate);
    recordConnectionDiagnostic({
      ...common,
      state: 'failed',
      durationMs,
      errorKind,
      ...(errorKind === 'timeout' ? { timerLagMs: Math.max(0, durationMs - timeoutMs) } : {}),
    });
    throw error;
  }
}
