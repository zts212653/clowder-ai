import { z } from 'zod';

export const CLIENT_REQUEST_DIAGNOSTIC_HEADER = 'x-clowder-client-request';
/** Browser wall-clock ms when the request was handed to fetch; caller-supplied, timing only. */
export const CLIENT_SENT_AT_DIAGNOSTIC_HEADER = 'x-clowder-client-sent-at';
/** Every diagnostic request header the Hub adds; hand-written CORS allow-lists must accept all of them. */
export const CLIENT_DIAGNOSTIC_REQUEST_HEADERS: readonly string[] = [
  CLIENT_REQUEST_DIAGNOSTIC_HEADER,
  CLIENT_SENT_AT_DIAGNOSTIC_HEADER,
];
/**
 * F294: the same runtime revision /api/health publishes, on every Fastify API response (raw or
 * hijacked replies bypass it). While that revision
 * is unknown the value is DEPLOYMENT_REVISION_UNKNOWN, never absence: a 304 only replaces headers it
 * carries, so absence would let a revalidated cached copy keep an older revision.
 */
export const DEPLOYMENT_REVISION_HEADER = 'x-clowder-deployment-revision';
/** Not a revision; browsers treat it as no observation at all. */
export const DEPLOYMENT_REVISION_UNKNOWN = 'unknown';
export const CONNECTION_DIAGNOSTIC_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const id = z.string().regex(CONNECTION_DIAGNOSTIC_UUID);
const duration = z.number().finite().min(0).max(86_400_000);
const route = z.enum([
  'session',
  'messages',
  'threads',
  'artifacts',
  'paw_feel',
  'needs_me',
  'navigation_source',
  'other',
]);
const errorKind = z.enum(['timeout', 'aborted', 'network', 'other']);
const notice = z.enum(['not-saved', 'unavailable', 'interrupted', 'clear-failed', 'save-failed']);
const base = { eventId: id, at: z.number().int().nonnegative() };

/** Fixed vocabulary: no URL, query, message, title, token, stack or arbitrary error text. */
export const connectionDiagnosticEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...base,
      kind: z.literal('http'),
      clientRequestId: id,
      route,
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER']),
      state: z.enum(['start', 'finish', 'failed']),
      durationMs: duration.optional(),
      deadlineMs: duration.optional(),
      timerLagMs: duration.optional(),
      errorKind: errorKind.optional(),
      statusCode: z.number().int().min(100).max(599).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('connection_notice'),
      clientRequestId: id.optional(),
      route: route.optional(),
      state: z.enum(['shown', 'suppressed']),
      errorKind: z.enum(['timeout', 'network']),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('settings_return'),
      bridgeId: id,
      phase: z.enum(['created', 'capture', 'return', 'cancel', 'notice', 'consumed', 'presented', 'disposed']),
      cause: z
        .enum([
          'route',
          'reader_replaced',
          'reader_unregistered',
          'capture',
          'admission',
          'restore',
          'storage',
          'dispose',
          'retire',
          'return_mark',
        ])
        .optional(),
      notice: notice.nullable(),
      noticeSeq: z.number().int().nonnegative(),
      returning: z.boolean(),
      hasSource: z.boolean(),
      hasReader: z.boolean(),
      admitted: z.boolean(),
    })
    .strict(),
]);
export const connectionDiagnosticBatchSchema = z
  .object({
    v: z.literal(1),
    events: z.array(connectionDiagnosticEventSchema).min(1).max(60),
  })
  .strict();
export type ConnectionDiagnosticEvent = z.infer<typeof connectionDiagnosticEventSchema>;
export type ConnectionDiagnosticRoute = z.infer<typeof route>;
export type SettingsReturnDiagnostic = Extract<ConnectionDiagnosticEvent, { kind: 'settings_return' }>;

/** Classify before recording; raw identifiers and query strings never enter the diagnostic. */
export function connectionDiagnosticRoute(path: string): ConnectionDiagnosticRoute {
  const pathname = path.split('?')[0];
  if (pathname === '/api/session') return 'session';
  if (pathname === '/api/messages') return 'messages';
  if (pathname === '/api/threads') return 'threads';
  if (/^\/api\/threads\/[^/]+\/artifacts$/.test(pathname ?? '')) return 'artifacts';
  if (pathname === '/api/paw-feel/inbox') return 'paw_feel';
  if (pathname === '/api/entrusted-work/needs-me') return 'needs_me';
  if (pathname === '/api/evidence/navigation-source') return 'navigation_source';
  return 'other';
}
