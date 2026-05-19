import type { FastifyRequest } from 'fastify';
import { REDACTED_CAPABILITY_SECRET } from './capability-redaction.js';

export interface CapabilityWriteRouteError {
  status: number;
  error: string;
}

export function resolveCapabilityWriteSessionUserId(request: FastifyRequest): string | null {
  const sessionUserId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  return typeof sessionUserId === 'string' && sessionUserId.trim() ? sessionUserId.trim() : null;
}

export function requireCapabilityWriteOwner(userId: string): CapabilityWriteRouteError | null {
  const ownerId = process.env.DEFAULT_OWNER_USER_ID?.trim();
  if (!ownerId) {
    return {
      status: 403,
      error: 'Capability writes require DEFAULT_OWNER_USER_ID to be configured',
    };
  }
  if (userId !== ownerId) {
    return {
      status: 403,
      error: 'Capability writes can only be modified by the configured owner',
    };
  }
  return null;
}

export function containsRedactedPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(REDACTED_CAPABILITY_SECRET);
  if (Array.isArray(value)) return value.some((item) => containsRedactedPlaceholder(item));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => containsRedactedPlaceholder(item));
  }
  return false;
}
