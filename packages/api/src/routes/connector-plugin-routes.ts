/**
 * F240: Generic connector action routes — config write, action execute,
 * operation reset, and operation state listing.
 *
 * Split from connector-hub.ts to keep each file within the 350-line limit.
 * These routes use the YAML manifest-driven plugin architecture and are
 * connector-agnostic (no platform-specific logic).
 */

import { isOperationField, isValueField } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FastifyInstance } from 'fastify';
import { configEventBus, createChangeSetId } from '../config/config-event-bus.js';
import { containsRedactedPlaceholder } from '../config/connector-secret-write-guards.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { executeConnectorAction } from '../infrastructure/connectors/connector-action-handler.js';
import {
  readAllOperationStates,
  readConnectorStoredConfig,
  resolveConnectorEnv,
  writeConnectorConfig,
  writeOperationState,
} from '../infrastructure/connectors/im-connector-config-store.js';
import type { IMConnectorPlugin } from '../infrastructure/connectors/im-connector-plugin.js';
import type { IOutboundAdapter } from '../infrastructure/connectors/OutboundDeliveryHook.js';
import type { ConnectorManifest } from '../infrastructure/connectors/plugins/im-connector-manifest.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import {
  pickPendingActionValues,
  requireConnectorWriteIdentity,
  requireSessionHubIdentity,
  rollbackConnectorOperationTargets,
} from './connector-route-helpers.js';

// ── Route options ──

export interface ConnectorActionRoutesOptions {
  /** Manifest lookup by connector ID (built-in + installed plugins). */
  getManifests: () => Map<string, ConnectorManifest>;
  /** F240 A-3: Plugin registry for generic action endpoint (includes unconfigured plugins) */
  pluginRegistry?: ReadonlyMap<string, IMConnectorPlugin>;
  /** F240 A-3: Adapter registry for generic action endpoint (only configured+started connectors) */
  adapterRegistry?: ReadonlyMap<string, IOutboundAdapter>;
  /** F240 A-3: Activate a connector after credentials acquired via action */
  activateConnector?: (connectorId: string) => Promise<void>;
  /** F240 A-3: Deactivate a connector on disconnect */
  deactivateConnector?: (connectorId: string) => Promise<void>;
  /** Shared Redis dependency for external connector action handlers. */
  redis?: RedisClient | undefined;
}

// ── Route registration ──

export const connectorActionRoutes: (opts: ConnectorActionRoutesOptions) => (app: FastifyInstance) => void =
  (opts) => (app) => {
    // ── F240: Write connector config via config store ──

    app.put('/api/connectors/:connectorId/config', async (request, reply) => {
      const auth = requireConnectorWriteIdentity(request, reply);
      if (auth.error) return auth.error;
      const { userId } = auth;

      const { connectorId } = request.params as { connectorId: string };
      const manifest = opts.getManifests().get(connectorId);
      if (!manifest) {
        reply.status(404);
        return { error: `Unknown connector: ${connectorId}` };
      }

      const body = request.body as { fields?: { name: string; value: string | null }[] };
      if (!Array.isArray(body?.fields) || body.fields.length === 0) {
        reply.status(400);
        return { error: 'fields array required' };
      }

      // Validate field names against manifest — only value fields have envName (KD-17)
      const allowed = new Set(manifest.config.filter(isValueField).map((f) => f.envName));
      const invalid = body.fields.filter((f) => !allowed.has(f.name));
      if (invalid.length > 0) {
        reply.status(400);
        return { error: `Unknown fields: ${invalid.map((f) => f.name).join(', ')}` };
      }

      // Reject redacted placeholders
      if (containsRedactedPlaceholder(body.fields)) {
        reply.status(400);
        return { error: 'Refusing to write redacted connector placeholder values' };
      }

      const projectRoot = resolveActiveProjectRoot();
      const { changedKeys } = writeConnectorConfig(
        projectRoot,
        connectorId,
        body.fields.map((f) => ({ name: f.name, value: f.value })),
      );

      if (changedKeys.length > 0) {
        configEventBus.emitChange({
          source: 'config-store',
          scope: manifest.source === 'external' ? 'file' : 'key',
          changedKeys,
          changeSetId: createChangeSetId(),
          timestamp: Date.now(),
        });
        app.log.info({ connectorId, changedKeys, userId }, '[ConnectorHub] Config updated via generic route');
      }

      try {
        await getEventAuditLog().append({
          type: AuditEventTypes.CONFIG_UPDATED,
          data: {
            target: 'connector-config',
            action: `connector-config-write:${connectorId}`,
            keys: changedKeys,
            operator: userId,
          },
        });
      } catch (err) {
        app.log.warn({ err, connectorId, keys: changedKeys }, 'connector config audit append failed');
      }

      return { ok: true, changedKeys };
    });

    // ── F240 A-3: Generic operation reset ──

    app.post('/api/connectors/:connectorId/operations/:operationName/reset', async (request, reply) => {
      const auth = requireConnectorWriteIdentity(request, reply);
      if (auth.error) return auth.error;

      const { connectorId, operationName } = request.params as {
        connectorId: string;
        operationName: string;
      };
      const body = request.body as { currentAction?: string };
      const currentAction = body?.currentAction;
      if (!currentAction) {
        reply.status(400);
        return { error: 'currentAction required' };
      }

      const manifest = opts.getManifests().get(connectorId);
      if (!manifest) {
        reply.status(404);
        return { error: `Unknown connector: ${connectorId}` };
      }
      const operation = manifest.config.find((f) => isOperationField(f) && f.name === operationName);
      if (!operation || !isOperationField(operation)) {
        reply.status(404);
        return { error: `Operation '${operationName}' not found in connector '${connectorId}'` };
      }
      if (!operation.actions.some((a) => a.id === currentAction)) {
        reply.status(400);
        return { error: `Action '${currentAction}' not found in operation '${operationName}'` };
      }

      const projectRoot = resolveActiveProjectRoot();
      writeOperationState(projectRoot, connectorId, operationName, { currentAction });
      return { ok: true, currentAction };
    });

    // ── F240 A-3: Generic action endpoint (AC-A16) ──

    app.post('/api/connectors/:connectorId/actions/:operationName/:actionId', async (request, reply) => {
      const auth = requireConnectorWriteIdentity(request, reply);
      if (auth.error) return auth.error;

      const { connectorId, operationName, actionId } = request.params as {
        connectorId: string;
        operationName: string;
        actionId: string;
      };

      const manifest = opts.getManifests().get(connectorId);
      if (!manifest) {
        reply.status(404);
        return { error: `Unknown connector: ${connectorId}` };
      }

      const plugin = opts.pluginRegistry?.get(connectorId);
      if (!plugin) {
        reply.status(503);
        return { error: `Connector '${connectorId}' plugin not loaded` };
      }
      // Adapter is optional — unconfigured connectors (e.g. pre-QR-login) have no adapter yet
      const adapter = opts.adapterRegistry?.get(connectorId);

      const projectRoot = resolveActiveProjectRoot();
      // Resolve actual env (stored > env > default) so action handlers see real values
      const valueFields = manifest.config.filter(isValueField);
      const resolvedEnv = resolveConnectorEnv(connectorId, valueFields);
      const pendingActionValues = pickPendingActionValues(request.body, valueFields);
      if (containsRedactedPlaceholder(pendingActionValues)) {
        reply.status(400);
        return { error: 'Refusing to use redacted connector placeholder values' };
      }
      const operationDef = manifest.config.find((f) => isOperationField(f) && f.name === operationName);
      const operationTargetEnvNames =
        operationDef && isOperationField(operationDef) && Array.isArray(operationDef.target) ? operationDef.target : [];
      const previousTargetValues = new Map<string, string | null | undefined>();
      if (operationTargetEnvNames.length > 0) {
        const previousConfig = readConnectorStoredConfig(projectRoot, connectorId);
        for (const name of operationTargetEnvNames) {
          const previousValue = Object.hasOwn(previousConfig, name) ? previousConfig[name] : undefined;
          previousTargetValues.set(name, previousValue);
        }
      }

      const result = await executeConnectorAction({
        projectRoot,
        connectorId,
        operationName,
        actionId,
        manifest,
        plugin,
        pluginCtx: { env: { ...resolvedEnv, ...pendingActionValues }, log: app.log, redis: opts.redis },
        adapter,
        operator: auth.userId,
        auditLog: getEventAuditLog(),
      });

      if (!result.ok) {
        reply.status(result.status ?? 500);
        return { error: result.error };
      }

      // Lifecycle: activate after credential backfill, deactivate on explicit disconnect.
      let activationStatus: 'activated' | 'deactivated' | 'failed' | undefined;
      if (result.activate === false && opts.deactivateConnector) {
        try {
          await opts.deactivateConnector(connectorId);
          activationStatus = 'deactivated';
          app.log.info({ connectorId }, '[ConnectorHub] Connector deactivated after disconnect');
        } catch (err) {
          activationStatus = 'failed';
          rollbackConnectorOperationTargets({
            projectRoot,
            connectorId,
            targetEnvNames: operationTargetEnvNames,
            previousValues: previousTargetValues,
            manifestSource: manifest.source,
          });
          writeOperationState(projectRoot, connectorId, operationName, {
            currentAction: actionId,
            lastResult: {
              render: 'status',
              data: { status: 'deactivation_failed' },
              label: 'Deactivation failed',
            },
          });
          app.log.warn({ err, connectorId }, '[ConnectorHub] Connector deactivation failed');
          reply.status(502);
          return { ok: false, error: 'Connector deactivation failed after action succeeded', activationStatus };
        }
      } else if (
        (result.activate === true || (result.backfilledKeys && result.backfilledKeys.length > 0)) &&
        opts.activateConnector
      ) {
        try {
          await opts.activateConnector(connectorId);
          activationStatus = 'activated';
          app.log.info(
            { connectorId, backfilledKeys: result.backfilledKeys },
            '[ConnectorHub] Connector activated after credential backfill',
          );
        } catch (err) {
          activationStatus = 'failed';
          rollbackConnectorOperationTargets({
            projectRoot,
            connectorId,
            targetEnvNames: operationTargetEnvNames,
            previousValues: previousTargetValues,
            manifestSource: manifest.source,
          });
          writeOperationState(projectRoot, connectorId, operationName, {
            currentAction: actionId,
            lastResult: {
              render: 'status',
              data: { status: 'activation_failed' },
              label: 'Activation failed',
            },
          });
          app.log.warn(
            { err, connectorId },
            '[ConnectorHub] Connector activation failed after backfill — may need restart',
          );
          reply.status(502);
          return { ok: false, error: 'Connector activation failed after action succeeded', activationStatus };
        }
      }

      return {
        ok: true,
        render: result.render,
        data: result.data,
        ...(result.label ? { label: result.label } : {}),
        ...(result.backfilledKeys ? { backfilledKeys: result.backfilledKeys } : {}),
        ...(activationStatus ? { activationStatus } : {}),
      };
    });

    // ── F240 A-3: Operation state in status endpoint (AC-A20) ──

    app.get('/api/connectors/:connectorId/operations', async (request, reply) => {
      const userId = requireSessionHubIdentity(request, reply);
      if (!userId) return { error: 'Identity required' };

      const { connectorId } = request.params as { connectorId: string };
      const manifest = opts.getManifests().get(connectorId);
      if (!manifest) {
        reply.status(404);
        return { error: `Unknown connector: ${connectorId}` };
      }

      const projectRoot = resolveActiveProjectRoot();
      const states = readAllOperationStates(projectRoot, connectorId);
      return { operations: states };
    });
  };
