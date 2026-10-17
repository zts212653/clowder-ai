'use client';

import type { PluginManagerDetail } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useOptionalConfirm } from '@/components/useConfirm';
import { apiFetch } from '@/utils/api-client';
import { SettingsText } from '../primitives/SettingsText';

type Binding = NonNullable<PluginManagerDetail['bindings']>[number];

export function PluginManagerBindings({
  pluginId,
  bindings,
  onChange,
}: {
  pluginId: string;
  bindings: readonly Binding[];
  onChange?: () => void;
}) {
  const confirm = useOptionalConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const disconnect = async (binding: Binding) => {
    if (!confirm || busy) return;
    const accepted = await confirm({
      title: '断开会话绑定',
      message: `断开“${binding.threadTitle ?? binding.threadId}”与外部会话的绑定？会话和消息将保留。`,
      confirmLabel: '断开绑定',
      variant: 'danger',
    });
    if (!accepted || !mounted.current) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(
        `/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/bindings/disconnect`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            key: binding.key,
            threadId: binding.threadId,
            createdAt: binding.createdAt,
            confirmed: true,
          }),
        },
      );
      if (!mounted.current) return;
      if (!response.ok)
        setError(response.status === 409 ? '绑定已变化，请根据刷新后的列表重试。' : '断开失败，请稍后重试。');
      onChange?.();
    } catch {
      if (mounted.current) setError('断开失败，请检查连接后重试。');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section className="space-y-3" data-plugin-detail-section="bindings">
      <SettingsText as="h4" variant="xs" tone="muted" className="font-semibold">
        会话绑定
      </SettingsText>
      {error && (
        <p role="alert" className="text-sm text-conn-red-text">
          {error}
        </p>
      )}
      {bindings.length === 0 ? (
        <SettingsText as="p" variant="sm" tone="muted">
          暂无会话绑定。
        </SettingsText>
      ) : (
        <ul className="space-y-3">
          {bindings.map((binding) => (
            <li key={binding.key} className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <a className="console-inline-link break-all" href={`/thread/${encodeURIComponent(binding.threadId)}`}>
                  {binding.threadTitle ?? binding.threadId}
                </a>
                <SettingsText as="p" variant="xs" tone="muted" className="break-all">
                  {binding.key}
                </SettingsText>
              </div>
              <button
                type="button"
                disabled={busy || !confirm}
                className="console-inline-link shrink-0 disabled:opacity-50"
                onClick={() => void disconnect(binding)}
              >
                断开绑定
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
