import type { FastifyRequest } from 'fastify';
import { normalizeTelegramBotToken } from '../infrastructure/connectors/telegram-token.js';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { isConnectorSecret } from './connector-secrets-allowlist.js';

export const REDACTED_PLACEHOLDER = '••••••';

export interface ConnectorWriteRouteError {
  status: number;
  error: string;
}

export interface ConnectorSecretUpdateInput {
  name: string;
  value: string | null;
}

export function resolveConnectorSessionUserId(request: FastifyRequest): string | null {
  const sessionUserId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  return typeof sessionUserId === 'string' && sessionUserId.trim() ? sessionUserId.trim() : null;
}

export function requireConnectorWriteOwner(userId: string): ConnectorWriteRouteError | null {
  return resolveOwnerGate(userId, {
    errorMessage: 'Connector credential writes can only be modified by the configured owner',
  });
}

/**
 * Network guard for connector secret writes.
 *
 * When DEFAULT_OWNER_USER_ID is not configured (single-user mode), connector
 * writes are restricted to direct loopback requests (no proxy forwarding
 * headers). This prevents LAN/Tailscale/proxied clients from writing
 * connector secrets without an owner identity.
 *
 * When DEFAULT_OWNER_USER_ID IS configured, remote writes are allowed because
 * the owner gate provides identity-based access control.
 */
export function requireConnectorWriteNetworkGuard(request: FastifyRequest): ConnectorWriteRouteError | null {
  if (isDirectLoopbackRequest(request)) return null;
  if (process.env.DEFAULT_OWNER_USER_ID?.trim()) return null;
  return {
    status: 403,
    error: 'Connector credential writes from non-localhost require DEFAULT_OWNER_USER_ID to be configured',
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

export function validateConnectorSecretUpdate(update: ConnectorSecretUpdateInput): string | null {
  if (!isConnectorSecret(update.name)) return `'${update.name}' is not in connector secrets allowlist`;
  if (containsRedactedPlaceholder(update.value)) {
    return 'Refusing to write redacted connector placeholder values';
  }
  if (
    update.name === 'TELEGRAM_BOT_TOKEN' &&
    update.value != null &&
    update.value !== '' &&
    normalizeTelegramBotToken(update.value) == null
  ) {
    return 'TELEGRAM_BOT_TOKEN must look like a Telegram BotFather token (<digits>:<token>)';
  }
  if (update.name === 'VAPID_SUBJECT' && update.value != null && !isValidVapidSubject(update.value)) {
    return 'VAPID_SUBJECT must be a mailto: or https: subject';
  }
  return null;
}

export function validateConnectorSecretUpdates(updates: ConnectorSecretUpdateInput[]): string | null {
  for (const update of updates) {
    const error = validateConnectorSecretUpdate(update);
    if (error) return error;
  }
  return null;
}
