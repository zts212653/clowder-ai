/**
 * Connector Action Handler — AC-A15/A16/A19/A20/A21
 *
 * Pure logic for executing a connector action within an operation's state machine.
 * Called by the generic `POST /api/connectors/:id/actions/:operationName/:actionId` route.
 *
 * Responsibilities:
 * - Validate operation + action exist in manifest
 * - Call plugin.handleAction()
 * - Persist currentAction = next on success (AC-A20)
 * - Backfill target fields with targetValues (AC-A19)
 * - Persist lastResult for frontend rendering
 */

import { isOperationField, type OperationConfigField } from '@cat-cafe/shared';
import { configEventBus, createChangeSetId } from '../../config/config-event-bus.js';
import { AuditEventTypes, type EventAuditLog } from '../../domains/cats/services/orchestration/EventAuditLog.js';
import { transitionOperationState } from '../../domains/plugin/operations/operation-state-machine.js';
import { readOperationState, writeConnectorConfig, writeOperationState } from './im-connector-config-store.js';
import type {
  HandleActionContext,
  HandleActionResult,
  IMConnectorPlugin,
  IMConnectorPluginContext,
} from './im-connector-plugin.js';
import type { IOutboundAdapter } from './OutboundDeliveryHook.js';

// ── Types ───────────────────────────────────────────────────────────

interface ExecuteActionInput {
  projectRoot: string;
  connectorId: string;
  operationName: string;
  actionId: string;
  manifest: { id: string; source?: string; config: ReadonlyArray<{ type: string }> };
  plugin: Pick<IMConnectorPlugin, 'id' | 'handleAction'>;
  pluginCtx: IMConnectorPluginContext;
  /** Undefined when connector not yet configured (pre-activation actions like QR generate). */
  adapter: IOutboundAdapter | undefined;
  /** Session/user identity for config audit events. */
  operator?: string;
  auditLog?: Pick<EventAuditLog, 'append'>;
}

interface ExecuteActionSuccess {
  ok: true;
  render: string;
  data: unknown;
  label?: string;
  /** envNames that were backfilled by target values (AC-A19) */
  backfilledKeys?: string[];
  /** Whether the connector should be activated after backfill. Default: true.
   *  Disconnect actions set this to false to prevent restart after credential clear. */
  activate?: boolean;
}

interface ExecuteActionError {
  ok: false;
  error: string;
  status?: number;
}

export type ExecuteActionResult = ExecuteActionSuccess | ExecuteActionError;

// ── Implementation ──────────────────────────────────────────────────

export async function executeConnectorAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
  const {
    projectRoot,
    connectorId,
    operationName,
    actionId,
    manifest,
    plugin,
    pluginCtx,
    adapter,
    operator,
    auditLog,
  } = input;

  // 1. Find the operation in manifest
  const operation = (manifest.config as OperationConfigField[]).find(
    (f) => f.type === 'operation' && f.name === operationName,
  );

  if (!operation) {
    return { ok: false, error: `Operation '${operationName}' not found in connector '${connectorId}'`, status: 404 };
  }

  // 2. Find the action in the operation's chain
  const actionDef = operation.actions.find((a) => a.id === actionId);
  if (!actionDef) {
    return { ok: false, error: `Action '${actionId}' not found in operation '${operationName}'`, status: 404 };
  }

  // 3. Check plugin implements handleAction
  if (!plugin.handleAction) {
    return {
      ok: false,
      error: `handleAction not implemented by connector '${connectorId}'`,
      status: 501,
    };
  }

  // 4. Build context with current operation state
  const operationState = readOperationState(projectRoot, connectorId, operationName);
  const actionCtx: HandleActionContext = {
    ...pluginCtx,
    adapter,
    operationState,
  };

  // 5. Execute plugin action
  let result: HandleActionResult;
  try {
    result = await plugin.handleAction(operationName, actionId, actionCtx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Action failed: ${message}`, status: 502 };
  }

  // 6. Persist state — advance only when plugin signals completion (default: true)
  const transition = transitionOperationState({
    actions: operation.actions,
    actionId,
    currentState: operationState,
    targetKeys: operation.target,
    result,
    now: Date.now(),
    enforceTimeout: false,
  });
  writeOperationState(
    projectRoot,
    connectorId,
    operationName,
    {
      currentAction: transition.state.currentAction,
      ...(transition.state.lastResult === undefined ? {} : { lastResult: transition.state.lastResult }),
    },
    { preserveUpdatedAt: transition.preserveUpdatedAt },
  );

  // 7. Backfill target fields only on advance (AC-A19)
  let backfilledKeys: string[] | undefined;
  if (Object.keys(transition.targetValues).length > 0) {
    const updates: { name: string; value: string | null }[] = [];
    for (const [envName, value] of Object.entries(transition.targetValues)) {
      updates.push({ name: envName, value });
    }
    if (updates.length > 0) {
      const { changedKeys } = writeConnectorConfig(projectRoot, connectorId, updates);
      backfilledKeys = changedKeys;
      if (changedKeys.length > 0) {
        configEventBus.emitChange({
          source: 'config-store',
          scope: manifest.source === 'external' ? 'file' : 'key',
          changedKeys,
          changeSetId: createChangeSetId(),
          timestamp: Date.now(),
        });
      }
      if (operator && auditLog) {
        try {
          await auditLog.append({
            type: AuditEventTypes.CONFIG_UPDATED,
            data: {
              target: 'connector-config',
              action: `connector-action:${connectorId}:${operationName}:${actionId}`,
              keys: changedKeys,
              operator,
            },
          });
        } catch (err) {
          pluginCtx.log.warn({ err, connectorId, keys: changedKeys }, 'connector action backfill audit append failed');
        }
      }
    }
  }

  // 8. Return result
  return {
    ok: true,
    render: result.render,
    data: result.data,
    ...(result.label ? { label: result.label } : {}),
    ...(backfilledKeys && backfilledKeys.length > 0 ? { backfilledKeys } : {}),
    ...(result.activate !== undefined ? { activate: result.activate } : {}),
  };
}
