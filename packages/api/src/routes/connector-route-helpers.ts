/**
 * Shared helpers for connector routes (connector-hub.ts + connector-plugin-routes.ts).
 *
 * Extracted to eliminate duplication and keep route files within the 350-line limit.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { configEventBus, createChangeSetId } from '../config/config-event-bus.js';
import {
  requireConnectorWriteNetworkGuard,
  requireConnectorWriteOwner,
  resolveConnectorSessionUserId,
} from '../config/connector-secret-write-guards.js';
import { restoreConnectorConfigValues } from '../infrastructure/connectors/im-connector-config-store.js';
import type { ConnectorManifest } from '../infrastructure/connectors/plugins/im-connector-manifest.js';

// ── Auth helpers ──

export type ConnectorWriteIdentityResult =
  | { userId: string; error?: never }
  | { userId?: never; error: { error: string } };

export function requireSessionHubIdentity(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = resolveConnectorSessionUserId(request);
  if (!userId) {
    reply.status(401);
    return null;
  }
  return userId;
}

export function requireConnectorWriteIdentity(
  request: FastifyRequest,
  reply: FastifyReply,
): ConnectorWriteIdentityResult {
  const userId = requireSessionHubIdentity(request, reply);
  if (!userId) return { error: { error: 'Identity required' } };
  const networkError = requireConnectorWriteNetworkGuard(request);
  if (networkError) {
    reply.status(networkError.status);
    return { error: { error: networkError.error } };
  }
  const ownerError = requireConnectorWriteOwner(userId);
  if (ownerError) {
    reply.status(ownerError.status);
    return { error: { error: ownerError.error } };
  }
  return { userId };
}

// ── Utility helpers ──

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pickPendingActionValues(body: unknown, valueFields: { envName: string }[]): Record<string, string> {
  if (!isRecord(body) || !isRecord(body.values)) return {};

  const allowedNames = new Set(valueFields.map((field) => field.envName));
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(body.values)) {
    if (allowedNames.has(name) && typeof value === 'string') {
      values[name] = value;
    }
  }
  return values;
}

export function rollbackConnectorOperationTargets(input: {
  projectRoot: string;
  connectorId: string;
  targetEnvNames: readonly string[];
  previousValues: ReadonlyMap<string, string | null | undefined>;
  manifestSource: ConnectorManifest['source'];
}): string[] {
  if (input.targetEnvNames.length === 0) return [];

  const rollbackUpdates = input.targetEnvNames.map((name) => ({
    name,
    value: input.previousValues.get(name),
  }));
  const { changedKeys } = restoreConnectorConfigValues(input.projectRoot, input.connectorId, rollbackUpdates);
  if (changedKeys.length > 0) {
    configEventBus.emitChange({
      source: 'config-store',
      scope: input.manifestSource === 'external' ? 'file' : 'key',
      changedKeys,
      changeSetId: createChangeSetId(),
      timestamp: Date.now(),
    });
  }
  return changedKeys;
}
