'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../hub-icons';
import { ShellGlyph } from '../shell/ShellIcons';
import { ThreadSignalPills } from '../ThreadSidebar/ThreadRowSignals';

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
  unreadCounts,
  isV2 = false,
}: {
  onSelect(threadId: string): void;
  currentThreadId?: string | null;
  onThreadsChange?(threadIds: string[]): void;
  unreadCounts?: ReadonlyMap<string, number>;
  isV2?: boolean;
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
    <nav className={isV2 ? 'px-2.5 pb-2.5' : 'px-2 pb-2'} aria-label="常驻助手">
      {entries.map((entry) => {
        const settings = `/settings?s=plugins&plugin=${encodeURIComponent(entry.pluginId)}`;
        const selected = Boolean(entry.threadId) && entry.threadId === currentThreadId;
        const note = entry.status === 'ready' || entry.status === 'listening' ? undefined : labels[entry.status];
        const style = isV2
          ? {
              background: selected ? 'var(--shell-selected)' : undefined,
              color: selected ? 'var(--shell-ink)' : 'var(--shell-body)',
              fontWeight: selected ? 500 : undefined,
            }
          : undefined;
        const content = (
          <>
            <span
              className="flex-none text-cafe-muted"
              style={isV2 ? { color: 'var(--shell-muted)' } : undefined}
              aria-hidden="true"
            >
              <HubIcon name={typeof entry.icon === 'string' ? entry.icon : 'bot'} className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {note ? (
              <span
                className="flex-none text-xs text-cafe-muted"
                style={isV2 ? { color: 'var(--shell-muted)' } : undefined}
              >
                {note}
              </span>
            ) : null}
            <ThreadSignalPills
              unreadCount={entry.threadId ? (unreadCounts?.get(entry.threadId) ?? 0) : 0}
              hasUserMention={false}
              testIdPrefix="resident-entry"
            />
          </>
        );
        const className = `flex h-8 min-w-0 flex-1 items-center rounded-lg px-2 text-left ${
          isV2
            ? 'shell-nav-row shell-focusable w-full gap-2.5 text-sm'
            : `gap-2.5 text-[13px] text-cafe-secondary hover:bg-[var(--console-hover-bg)] ${selected ? 'bg-[var(--console-card-soft-bg)]' : ''}`
        }`;
        return (
          <div
            key={`${entry.instanceId}:${entry.commandId}`}
            className="group flex items-center gap-0.5"
            title={entry.detail}
          >
            {entry.threadId || entry.openable ? (
              <button
                type="button"
                className={className}
                style={style}
                aria-label={`${entry.label}，${labels[entry.status]}`}
                aria-current={selected ? 'page' : undefined}
                data-selected={selected ? 'true' : undefined}
                data-chat-background-surface={selected ? 'selected' : undefined}
                disabled={opening === `${entry.instanceId}:${entry.commandId}`}
                aria-busy={opening === `${entry.instanceId}:${entry.commandId}` || undefined}
                onClick={() => void open(entry)}
              >
                {content}
              </button>
            ) : (
              <a
                className={className}
                style={style}
                href={settings}
                aria-label={`${entry.label}，${labels[entry.status]}`}
              >
                {content}
              </a>
            )}
            {(entry.threadId || entry.openable) && (
              <a
                className="shell-focusable flex h-5 w-5 flex-none items-center justify-center rounded text-cafe-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                style={isV2 ? { color: 'var(--shell-muted)' } : undefined}
                href={settings}
                aria-label={`${entry.label}设置`}
                title={`${entry.label}设置`}
              >
                <ShellGlyph name="settings" className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        );
      })}
    </nav>
  );
}
