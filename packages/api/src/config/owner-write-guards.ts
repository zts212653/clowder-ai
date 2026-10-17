import type { FastifyRequest } from 'fastify';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { isHostSecret } from './host-secrets-allowlist.js';

export const REDACTED_PLACEHOLDER = '••••••';

export interface OwnerWriteRouteError {
  status: number;
  error: string;
}

export interface HostSecretUpdateInput {
  name: string;
  value: string | null;
}

export function resolveSessionUserId(request: FastifyRequest): string | null {
  const sessionUserId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  return typeof sessionUserId === 'string' && sessionUserId.trim() ? sessionUserId.trim() : null;
}

export function requireOwnerWrite(userId: string): OwnerWriteRouteError | null {
  return resolveOwnerGate(userId, {
    errorMessage: 'Host credential writes can only be modified by the configured owner',
  });
}

/**
 * Network guard for Host secret writes.
 *
 * When DEFAULT_OWNER_USER_ID is not configured (single-user mode), Host
 * writes are restricted to direct loopback requests (no proxy forwarding
 * headers). This prevents LAN/Tailscale/proxied clients from writing
 * Host secrets without an owner identity.
 *
 * When DEFAULT_OWNER_USER_ID IS configured, remote writes are allowed because
 * the owner gate provides identity-based access control.
 */
export function requireOwnerWriteNetworkGuard(request: FastifyRequest): OwnerWriteRouteError | null {
  if (isDirectLoopbackRequest(request)) return null;
  if (process.env.DEFAULT_OWNER_USER_ID?.trim()) return null;
  return {
    status: 403,
    error: 'Host credential writes from non-localhost require DEFAULT_OWNER_USER_ID to be configured',
  };
}

export function containsRedactedPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(REDACTED_PLACEHOLDER);
  if (Array.isArray(value)) return value.some((item) => containsRedactedPlaceholder(item));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => containsRedactedPlaceholder(item));
  }
  return false;
}

function isValidVapidSubject(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const subject = new URL(trimmed);
    if (subject.protocol === 'mailto:') return subject.pathname.trim().length > 0;
    if (subject.protocol === 'https:') return subject.hostname.trim().length > 0;
    return false;
  } catch {
    return false;
  }
}

export function validateHostSecretUpdate(update: HostSecretUpdateInput): string | null {
  if (!isHostSecret(update.name)) return `'${update.name}' is not in Host secrets allowlist`;
  if (containsRedactedPlaceholder(update.value)) {
    return 'Refusing to write redacted secret placeholder values';
  }
  if (update.name === 'VAPID_SUBJECT' && update.value != null && !isValidVapidSubject(update.value)) {
    return 'VAPID_SUBJECT must be a mailto: or https: subject';
  }
  return null;
}

export function validateHostSecretUpdates(updates: HostSecretUpdateInput[]): string | null {
  for (const update of updates) {
    const error = validateHostSecretUpdate(update);
    if (error) return error;
  }
  return null;
}
