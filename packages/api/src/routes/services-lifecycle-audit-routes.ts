import type { FastifyInstance } from 'fastify';
import { lifecycleOwnerError, requireLifecycleOwner } from './services-lifecycle-helpers.js';

export const SERVICE_LIFECYCLE_AUDIT_TYPE = 'service.lifecycle.write';

export interface ServiceLifecycleAuditEvent {
  id?: string;
  type: string;
  timestamp?: number;
  data?: Record<string, unknown>;
}

export interface ServiceLifecycleAuditLog {
  append(input: { type: string; data: Record<string, unknown> }): Promise<unknown>;
  readByType?(type: string, options?: { days?: number }): Promise<ServiceLifecycleAuditEvent[]>;
  listFiles?(): Promise<string[]>;
}

const AUDIT_DATA_KEYS = ['serviceId', 'action', 'operator', 'status', 'code', 'reason'] as const;

function sanitizeAuditData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  const source = data as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const key of AUDIT_DATA_KEYS) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number' || value === null) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function sanitizeAuditEvent(event: ServiceLifecycleAuditEvent): ServiceLifecycleAuditEvent {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    data: sanitizeAuditData(event.data),
  };
}

export async function registerServiceLifecycleAuditRoutes(
  app: FastifyInstance,
  auditLog: ServiceLifecycleAuditLog,
): Promise<void> {
  app.get('/api/services/audit', async (request, reply) => {
    const operator = requireLifecycleOwner(request, reply);
    if (!operator) return lifecycleOwnerError(reply);

    const events = auditLog.readByType ? await auditLog.readByType(SERVICE_LIFECYCLE_AUDIT_TYPE, { days: 7 }) : [];
    const logFiles = auditLog.listFiles ? await auditLog.listFiles() : [];
    return {
      events: events.map(sanitizeAuditEvent),
      logFiles,
    };
  });
}
