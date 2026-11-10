'use client';

import type { PluginManagerConfigField } from '@cat-cafe/shared';
import { useMemo } from 'react';
import type { PlatformOperationStatus } from '../../HubConfigIcons';
import { ActionRenderer } from '../primitives/ActionRenderer';
import { SettingsField } from '../primitives/SettingsField';

export function PluginManagerOperationField({
  pluginId,
  field,
  pendingConfigValues,
  onStatusChange,
  refreshRevision,
}: {
  pluginId: string;
  field: PluginManagerConfigField;
  pendingConfigValues: Readonly<Record<string, string>>;
  onStatusChange?: () => void;
  refreshRevision?: number;
}) {
  const operation = useMemo<PlatformOperationStatus>(
    () => ({
      name: field.key,
      label: field.label,
      actions: field.actions ?? [],
      ...(field.rowActions === undefined ? {} : { rowActions: field.rowActions }),
      ...(field.operationState?.currentAction === undefined
        ? {}
        : { currentAction: field.operationState.currentAction }),
      ...(field.operationState?.updatedAt === undefined ? {} : { updatedAt: field.operationState.updatedAt }),
    }),
    [field],
  );
  if (field.kind !== 'operation' || !field.actions?.length) return null;
  return (
    <SettingsField label={field.label} hint={field.description}>
      <ActionRenderer
        target={{ kind: 'plugin', id: pluginId }}
        operation={operation}
        configured={field.configured}
        pendingConfigValues={pendingConfigValues}
        onStatusChange={onStatusChange}
        refreshRevision={refreshRevision}
      />
    </SettingsField>
  );
}
