'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';
import { PluginVisual } from '../settings/plugin-manager/PluginVisual';

const entriesSchema = z.object({
  entries: z.array(
    z.object({
      pluginId: z.string(),
      instanceId: z.string(),
      commandId: z.string(),
      label: z.string(),
      threadId: z.string().nullable(),
      status: z.enum(['setup', 'disabled', 'starting', 'ready', 'listening', 'paused', 'error']),
      openable: z.boolean().default(false),
      badgeCount: z.number().int().nonnegative().default(0),
      icon: z.union([z.string(), z.object({ type: z.enum(['svg', 'png']), src: z.string() })]).optional(),
      detail: z.string().optional(),
    }),
  ),
});
const labels = {
  setup: '待设置',
  disabled: '未启用',
  starting: '启动中',
  ready: '可用',
  listening: '监听中',
  paused: '已暂停',
  error: '不可用',
};

/** Native conversation navigation for every installed thread-sidebar.top contribution. */
export function PluginConversationEntries({
  onSelect,
  currentThreadId,
  onThreadsChange,
}: {
  onSelect(threadId: string): void;
  currentThreadId?: string | null;
  onThreadsChange?(threadIds: string[]): void;
}) {
  const [entries, setEntries] = useState<z.infer<typeof entriesSchema>['entries']>([]);
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => {
    onThreadsChange?.(entries.flatMap((entry) => (entry.threadId ? [entry.threadId] : [])));
  }, [entries, onThreadsChange]);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (document.hidden) return;
      const result = await apiFetch('/api/plugin-conversations')
        .then(async (response) => {
          if (!response.ok) throw new Error('Resident entries unavailable');
          return entriesSchema.parse(await response.json()).entries;
        })
        .then(
          (rows) => ({ rows }),
          () => ({ rows: null }),
        );
      if (active) setEntries((previous) => result.rows ?? previous.map((entry) => ({ ...entry, status: 'error' })));
    };
    void refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('plugin-targets-changed', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('plugin-targets-changed', refresh);
    };
  }, []);
  const open = async (entry: z.infer<typeof entriesSchema>['entries'][number]) => {
    if (entry.threadId) {
      onSelect(entry.threadId);
      return;
    }
    const key = `${entry.instanceId}:${entry.commandId}`;
    setOpening(key);
    const result = await apiFetch(
      `/api/plugin-conversations/${encodeURIComponent(entry.instanceId)}/${encodeURIComponent(entry.commandId)}/open`,
      { method: 'POST' },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('Resident conversation unavailable');
        return z.object({ entry: entriesSchema.shape.entries.element }).parse(await response.json()).entry;
      })
      .then(
        (row) => row,
        () => null,
      );
    setOpening(null);
    if (!result) {
      setEntries((previous) =>
        previous.map((row) =>
          row.instanceId === entry.instanceId && row.commandId === entry.commandId ? { ...row, status: 'error' } : row,
        ),
      );
      return;
    }
    setEntries((previous) =>
      previous.map((row) => (row.instanceId === entry.instanceId && row.commandId === entry.commandId ? result : row)),
    );
    if (result.threadId) onSelect(result.threadId);
    else window.location.assign(`/settings?s=plugins&plugin=${encodeURIComponent(entry.pluginId)}`);
  };
  if (!entries.length) return null;
  return (
    <nav className="px-2 pb-2" aria-label="常驻助手">
      {entries.map((entry) => {
        const settings = `/settings?s=plugins&plugin=${encodeURIComponent(entry.pluginId)}`;
        const content = (
          <>
            <PluginVisual icon={entry.icon ?? 'message'} name={entry.label} className="!h-7 !w-7 shrink-0" />
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-xs font-medium">{entry.label}</span>
              <span className="block text-[10px] text-cafe-muted">{labels[entry.status]}</span>
            </span>
            {entry.badgeCount > 0 && (
              <span
                className="rounded-full bg-[var(--surface-sunken)] px-1.5 text-[10px] tabular-nums"
                role="status"
                aria-label={`${entry.badgeCount} 项待处理`}
              >
                {entry.badgeCount}
              </span>
            )}
          </>
        );
        const className = `flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-cafe-black hover:bg-[var(--console-hover-bg)] ${entry.threadId === currentThreadId ? 'bg-[var(--console-card-soft-bg)]' : ''}`;
        return (
          <div
            key={`${entry.instanceId}:${entry.commandId}`}
            className="flex items-center gap-0.5"
            title={entry.detail}
          >
            {entry.threadId || entry.openable ? (
              <button
                type="button"
                className={className}
                aria-label={`${entry.label}，${labels[entry.status]}`}
                aria-current={entry.threadId === currentThreadId ? 'page' : undefined}
                disabled={opening === `${entry.instanceId}:${entry.commandId}`}
                aria-busy={opening === `${entry.instanceId}:${entry.commandId}` || undefined}
                onClick={() => void open(entry)}
              >
                {content}
              </button>
            ) : (
              <a className={className} href={settings}>
                {content}
              </a>
            )}
            {(entry.threadId || entry.openable) && (
              <a
                className="rounded px-1 py-2 text-[10px] text-cafe-muted hover:text-cafe-black"
                href={settings}
                aria-label={`${entry.label}设置`}
              >
                设置
              </a>
            )}
          </div>
        );
      })}
    </nav>
  );
}
