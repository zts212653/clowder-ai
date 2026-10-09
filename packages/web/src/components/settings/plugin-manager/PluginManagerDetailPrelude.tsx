import type { ReactNode } from 'react';
import { SettingsText } from '../primitives/SettingsText';
import { pluginAttentionReason } from './plugin-manager-attention';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

/** The existing operation renderer stays mounted here whether attention clears or returns. */
export function PluginManagerDetailPrelude({
  plugin,
  description,
  operations,
}: {
  plugin: PluginManagerDesignFixture;
  description: string;
  operations: ReactNode;
}) {
  const reason = pluginAttentionReason(plugin);
  const hasOperations =
    plugin.artifact === 'installed' &&
    plugin.configFields?.some((field) => field.kind === 'operation' && field.actions?.length);
  return (
    <>
      {(reason || hasOperations) && (
        <section data-plugin-detail-section={reason ? 'attention' : 'operations'} className="space-y-3">
          {reason && (
            <div className="space-y-1 rounded-xl border border-cafe-border px-3 py-2.5">
              <SettingsText as="p" variant="sm" tone="default">
                <span aria-hidden className="mr-2 inline-block h-2 w-2 rounded-full bg-conn-amber-text" />
                {reason}
              </SettingsText>
              <SettingsText as="p" variant="sm" tone="secondary">
                {plugin.artifact !== 'installed'
                  ? '请检查安装包和插件文档中的安装要求。'
                  : hasOperations
                    ? '核对下方配置，再使用插件提供的操作处理。'
                    : '检查下方配置与插件文档，确认后再从列表启用。'}
              </SettingsText>
            </div>
          )}
          {hasOperations && (
            <div className="space-y-2" data-plugin-detail-section="plugin-operations">
              <SettingsText as="h4" variant="xs" tone="muted" className="font-semibold">
                插件操作
              </SettingsText>
              {operations}
            </div>
          )}
        </section>
      )}
      <section className="space-y-2" data-plugin-detail-section="introduction">
        <SettingsText as="h4" variant="xs" tone="muted" className="font-semibold">
          简介
        </SettingsText>
        <SettingsText as="p" variant="sm" tone="secondary">
          {description}
        </SettingsText>
      </section>
      {!reason && plugin.diagnostic && (
        <details className="text-sm text-cafe-muted">
          <summary>诊断记录</summary>
          <p className="mt-1">{plugin.diagnostic}</p>
        </details>
      )}
    </>
  );
}
