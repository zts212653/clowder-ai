'use client';

import type { PluginManagerConfigField } from '@cat-cafe/shared';
import type { PlatformOperationStatus } from '../../HubConfigIcons';
import { ActionRenderer } from '../primitives/ActionRenderer';

export function PluginManagerOperationField({
  pluginId,
  field,
  pendingConfigValues,
  onStatusChange,
}: {
  pluginId: string;
  field: PluginManagerConfigField;
  pendingConfigValues: Readonly<Record<string, string>>;
  onStatusChange?: () => void;
}) {
  if (field.kind !== 'operation' || !field.actions?.length) return null;
  const operation: PlatformOperationStatus = {
    name: field.key,
    label: field.label,
    actions: field.actions,
    ...(field.operationState?.currentAction === undefined ? {} : { currentAction: field.operationState.currentAction }),
    ...(field.operationState?.lastResult === undefined ? {} : { lastResult: field.operationState.lastResult }),
    ...(field.operationState?.updatedAt === undefined ? {} : { updatedAt: field.operationState.updatedAt }),
  };
  return (
    <ActionRenderer
      target={{ kind: 'plugin', id: pluginId }}
      operation={operation}
      configured={field.configured}
      pendingConfigValues={pendingConfigValues}
      onStatusChange={onStatusChange}
    />
  );
}
