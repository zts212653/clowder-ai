'use client';

import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLabelStore } from '@/stores/label-store';
import { projectSidebarRows, useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { apiFetch } from '@/utils/api-client';
import { bootstrapSidebarThreadSnapshot, refreshSidebarThreadSnapshot } from '@/utils/sidebar-thread-snapshot';
import type { PlatformActionDef } from '../../HubConfigIcons';
import { SidebarPinIcon } from '../../ThreadSidebar/ThreadPinV2';
import { projectDisplayName } from '../../ThreadSidebar/thread-utils';
import { useAttentionClusters } from '../../ThreadSidebar/use-attention-clusters';
import type { ActionRendererProps } from './ActionRenderer';
import { type ActionApiResult, actionCallFailure, actionRequest, rowActionRequest } from './ActionRendererState';
import {
  awaitingOwnerMessage,
  confirmedActionRequest,
  invocationAllowed,
  useActionConfirmation,
} from './actionConfirmation';
import { buildThreadPickerRows } from './thread-picker-projection';

interface PickerData {
  readonly selected: string[];
  readonly excluded: string[];
}

function pickerDataFrom(result: ActionApiResult | undefined): PickerData | undefined {
  if (result?.render !== 'thread-picker' || result.data === null || typeof result.data !== 'object') return undefined;
  const data = result.data as { selected?: unknown; excluded?: unknown };
  const valid = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((id) => typeof id === 'string');
  if (!valid(data.selected) || !valid(data.excluded)) return undefined;
  return { selected: [...new Set(data.selected)], excluded: [...new Set(data.excluded)] };
}

function uniqueLabels(ids: readonly string[], names: ReadonlyMap<string, string>): string[] {
  return [
    ...new Set(
      ids.flatMap((id) => {
        const name = names.get(id);
        return name ? [name] : [];
      }),
    ),
  ];
}

/**
 * Generic Host renderer for an operation whose list action returns
 * `{ render: 'thread-picker', data: { selected, excluded } }`.
 *
 * The picker reads the real Sidebar projection and attention Groups; the plugin owns only the
 * selected IDs. Nothing here is specific to one plugin. A checked row never changes the order.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one renderer owns load, draft, save and focus lifecycles; splitting would duplicate the same protocol state.
export function ThreadPickerRenderer({
  target,
  operation,
  onStatusChange,
  refreshRevision,
  listAction,
}: ActionRendererProps & { listAction: PlatformActionDef }) {
  const stableTarget = useMemo(() => ({ kind: target.kind, id: target.id }) as typeof target, [target.kind, target.id]);
  const rows = useSidebarProjectionStore((state) => state.rows);
  const pendingThreadCommands = useSidebarProjectionStore((state) => state.pendingThreadCommands);
  const labels = useLabelStore((state) => state.labels);
  const labelNames = useMemo(() => new Map(labels.map((label) => [label.id, label.name])), [labels]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const [directoryState, setDirectoryState] = useState<'loading' | 'ready' | 'error'>(() => {
    const state = useSidebarProjectionStore.getState();
    return state.rows.length > 0 && state.hasCanonicalSnapshot ? 'ready' : 'loading';
  });
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const originRef = useRef<HTMLElement | null>(null);
  const attemptedDirectory = useRef(false);
  const previousRefreshRevision = useRef(refreshRevision);
  const confirmAction = useActionConfirmation();
  const choose = operation.rowActions?.find((action) => action.id === 'choose');

  const projectedRows = useMemo(
    () => projectSidebarRows({ rows, pendingThreadCommands }),
    [pendingThreadCommands, rows],
  );
  const selectableRows = useMemo(
    () =>
      projectedRows.filter(
        (row) => row.id !== 'default' && row.systemKind === null && !row.isHubThread && !excluded.has(row.id),
      ),
    [excluded, projectedRows],
  );
  const selectableIds = useMemo(() => new Set(selectableRows.map((row) => row.id)), [selectableRows]);
  const validSelected = useMemo(
    () => new Set([...selected].filter((id) => selectableIds.has(id))),
    [selectableIds, selected],
  );
  const { clusters, memberSort, titleFor, groupLoadState, groupLoadError, reloadGroups } = useAttentionClusters(
    selectableRows,
    '',
    '',
  );
  const pickerRows = useMemo(
    () => buildThreadPickerRows({ rows: selectableRows, clusters, memberSort, query }),
    [clusters, memberSort, query, selectableRows],
  );

  const send = useCallback(
    async (
      declared: string | undefined,
      request: { readonly url: string; readonly init: RequestInit },
      confirmed: boolean,
    ): Promise<ActionApiResult | null> => {
      if (!invocationAllowed(declared, confirmed)) return null;
      try {
        const response = await apiFetch(request.url, confirmedActionRequest(request.init, declared, confirmed));
        const body = (await response.json().catch(() => ({}))) as ActionApiResult & { error?: string };
        if (!response.ok) return { ok: false, label: body.error ?? '请求失败' };
        return body;
      } catch {
        return { ok: false, label: '网络错误' };
      }
    },
    [],
  );

  const load = useCallback(
    async (confirmed: boolean) => {
      setListError(null);
      setListing(true);
      const request = actionRequest(stableTarget, operation.name, listAction.id);
      const result = await send(listAction.confirm, request, confirmed);
      setListing(false);
      if (result === null) {
        setListError(awaitingOwnerMessage(listAction.label));
        return;
      }
      if (!result.ok) {
        setListError(result.label ?? '会话列表不可用');
        return;
      }
      const data = pickerDataFrom(result);
      if (!data) {
        setListError('会话列表返回了无法识别的数据');
        return;
      }
      const nextExcluded = new Set(data.excluded);
      setSelected(new Set(data.selected));
      setExcluded(nextExcluded);
      setDraft((current) => new Set([...current].filter((id) => !nextExcluded.has(id))));
      setLoaded(true);
    },
    [listAction.confirm, listAction.id, listAction.label, operation.name, send, stableTarget],
  );

  const ensureDirectory = useCallback(async () => {
    setDirectoryState('loading');
    setDirectoryError(null);
    await bootstrapSidebarThreadSnapshot();
    const refreshed = await refreshSidebarThreadSnapshot();
    const state = useSidebarProjectionStore.getState();
    if (!state.hasCanonicalSnapshot) {
      setDirectoryState('error');
      setDirectoryError('会话目录暂时读不到，请重试。');
      return;
    }
    setDirectoryState('ready');
    if (!refreshed) setDirectoryError('会话目录刷新失败，当前显示缓存。');
  }, []);

  useEffect(() => {
    if (attemptedDirectory.current) return;
    const state = useSidebarProjectionStore.getState();
    if (state.rows.length > 0 && state.hasCanonicalSnapshot) {
      setDirectoryState('ready');
      return;
    }
    attemptedDirectory.current = true;
    void ensureDirectory();
  }, [ensureDirectory]);

  useEffect(() => {
    if (listAction.confirm !== undefined) return;
    void load(false);
  }, [listAction.confirm, load]);

  useEffect(() => {
    if (previousRefreshRevision.current === refreshRevision) return;
    previousRefreshRevision.current = refreshRevision;
    if (listAction.confirm !== undefined) return;
    void load(false);
  }, [listAction.confirm, load, refreshRevision]);

  const retry = useCallback(async () => {
    const allowed = await confirmAction(listAction.label, listAction.confirm);
    if (allowed) await load(listAction.confirm !== undefined);
  }, [confirmAction, listAction.confirm, listAction.label, load]);

  const openPicker = useCallback(() => {
    if (!loaded || directoryState !== 'ready') return;
    setDraft(new Set(validSelected));
    setQuery('');
    setSaveError(null);
    setOpen(true);
  }, [directoryState, loaded, validSelected]);

  const closePicker = useCallback(() => {
    if (saving) return;
    setOpen(false);
    setQuery('');
    setSaveError(null);
  }, [saving]);

  useEffect(() => {
    if (!open) return;
    originRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus({ preventScroll: true });
    return () => {
      const origin = originRef.current;
      if (origin?.isConnected) origin.focus({ preventScroll: true });
    };
  }, [open]);

  const handleDialogKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePicker();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []),
      ];
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    },
    [closePicker],
  );

  const toggle = useCallback((id: string) => {
    setDraft((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    if (!choose || saving || !open) return;
    if (!(await confirmAction(choose.label ?? '保存', choose.confirm))) return;
    setSaving(true);
    setSaveError(null);
    const request = rowActionRequest(stableTarget, operation.name, choose.id, {
      selection: 'threads',
      ids: [...draft],
    });
    const result = await send(choose.confirm, request, true);
    if (result === null) {
      setSaving(false);
      setSaveError(awaitingOwnerMessage(choose.label ?? '保存'));
      return;
    }
    const failure = actionCallFailure(result);
    if (failure !== null) {
      setSaving(false);
      setSaveError(failure);
      return;
    }
    const data = pickerDataFrom(result);
    setSelected(new Set(data?.selected ?? draft));
    setExcluded(new Set(data?.excluded ?? excluded));
    setLoaded(true);
    setSaving(false);
    setOpen(false);
    setQuery('');
    onStatusChange?.();
  }, [choose, confirmAction, draft, excluded, onStatusChange, open, operation.name, saving, send, stableTarget]);

  const displayDetail = (row: (typeof selectableRows)[number]) => {
    const parts = [projectDisplayName(row.projectPath), ...uniqueLabels(row.labels, labelNames)];
    return parts.filter(Boolean).join(' · ');
  };

  const renderThread = (row: (typeof selectableRows)[number], member: boolean) => (
    <label
      key={row.id}
      data-testid={`thread-picker-row-${row.id}`}
      className={`flex cursor-pointer items-start gap-2.5 py-2 pr-4 hover:bg-[var(--console-hover-bg)] ${
        member ? 'pl-9' : 'pl-4'
      }`}
    >
      <input
        type="checkbox"
        data-testid={`thread-picker-check-${row.id}`}
        aria-label={`选择${row.title ?? '未命名会话'}`}
        checked={draft.has(row.id)}
        onChange={() => toggle(row.id)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--cafe-accent)]"
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          {row.pinned ? <SidebarPinIcon pinned /> : null}
          <span className="truncate text-sm text-cafe-black">{row.title ?? '未命名会话'}</span>
        </span>
        {displayDetail(row) ? (
          <span className="mt-0.5 block truncate text-xs text-cafe-muted">{displayDetail(row)}</span>
        ) : null}
      </span>
    </label>
  );

  const summaryText =
    directoryState === 'loading'
      ? '正在读取会话目录…'
      : directoryState === 'error'
        ? '会话目录不可用'
        : !loaded
          ? listing
            ? '正在读取监听范围…'
            : '监听会话'
          : `已选 ${validSelected.size} 个会话`;

  return (
    <div className="space-y-2" data-testid={`${target.id}-thread-picker`}>
      <div className="rounded-lg border border-cafe-border px-3 py-2" data-testid="thread-picker-summary">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{summaryText}</p>
            <p className="text-xs text-cafe-muted">分组、置顶与顺序与左侧会话列表一致；勾选不会移动会话。</p>
          </div>
          {directoryState === 'loading' ? (
            <output className="text-xs text-cafe-muted">正在读取会话目录…</output>
          ) : directoryState === 'error' ? (
            <button
              type="button"
              data-testid="thread-picker-retry-directory"
              className="rounded-lg border border-cafe-border px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:bg-cafe-surface-sunken"
              onClick={() => void ensureDirectory()}
            >
              重试读取目录
            </button>
          ) : loaded ? (
            <button
              type="button"
              data-testid="thread-picker-open"
              className="rounded-lg border border-cafe-border px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:bg-cafe-surface-sunken"
              onClick={openPicker}
            >
              选择监听会话…
            </button>
          ) : listError ? (
            <button
              type="button"
              data-testid="thread-picker-retry"
              className="rounded-lg border border-cafe-border px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:bg-cafe-surface-sunken"
              onClick={() => void retry()}
            >
              重试
            </button>
          ) : listAction.confirm !== undefined ? (
            <button
              type="button"
              data-testid="thread-picker-read"
              className="rounded-lg border border-cafe-border px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:bg-cafe-surface-sunken"
              disabled={listing}
              onClick={() => void retry()}
            >
              {listAction.label}
            </button>
          ) : (
            <output className="text-xs text-cafe-muted">正在读取监听范围…</output>
          )}
        </div>
        {directoryState === 'ready' && directoryError && (
          <output className="mt-1 block text-xs text-conn-amber-text">
            {directoryError}{' '}
            <button
              type="button"
              data-testid="thread-picker-refresh-directory"
              className="underline underline-offset-2"
              onClick={() => void ensureDirectory()}
            >
              重试目录
            </button>
          </output>
        )}
        {!choose && <p className="mt-1 text-xs text-conn-red-text">保存动作未声明，无法保存选择。</p>}
        {listError && (
          <p role="alert" className="mt-1 text-xs text-conn-red-text">
            {listError}
          </p>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-3 backdrop-blur-sm sm:p-6">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onKeyDown={handleDialogKey}
            className="flex max-h-[90vh] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-cafe bg-cafe-surface shadow-xl sm:max-h-[78vh]"
            data-testid="thread-picker-dialog"
          >
            <div className="flex items-start justify-between gap-3 border-b border-cafe-subtle px-4 py-3">
              <div>
                <h3 id={titleId} className="text-base font-semibold text-cafe-black">
                  选择监听会话
                </h3>
                <p className="mt-0.5 text-xs text-cafe-muted">与左侧会话列表同分组、同置顶、同顺序。</p>
              </div>
              <button
                type="button"
                aria-label="关闭"
                className="rounded-md px-2 py-1 text-sm text-cafe-muted hover:bg-cafe-surface-elevated hover:text-cafe-black"
                onClick={closePicker}
                disabled={saving}
              >
                ×
              </button>
            </div>

            <div className="border-b border-cafe-subtle px-4 py-2">
              <input
                ref={searchRef}
                type="search"
                data-testid="thread-picker-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索会话或项目…"
                className="w-full rounded-lg border border-cafe-subtle bg-cafe-surface-elevated px-3 py-2 text-sm text-cafe-black outline-none placeholder:text-cafe-muted focus:ring-2 focus:ring-[var(--semantic-info)]"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {groupLoadState === 'error' && (
                <div className="border-b border-cafe-subtle px-4 py-2 text-xs text-cafe-muted">
                  <p role="alert">{groupLoadError ?? '分组读取失败，按最近顺序显示。'}</p>
                  <button
                    type="button"
                    className="mt-1 underline underline-offset-2"
                    onClick={() => void reloadGroups()}
                  >
                    重试读取分组
                  </button>
                </div>
              )}
              {pickerRows.length === 0 ? (
                <p className="px-4 py-6 text-sm text-cafe-muted" data-testid="thread-picker-empty">
                  还没有可监听的会话。
                </p>
              ) : (
                pickerRows.map((item, index) => {
                  if (item.kind === 'cluster-header') {
                    return (
                      <div
                        key={`group:${item.cluster.anchor}:${index}`}
                        data-testid={`thread-picker-group-${item.cluster.anchor}`}
                        className="flex items-center justify-between gap-2 border-y border-cafe-subtle bg-cafe-surface-elevated px-4 py-1.5 text-xs font-medium text-cafe-secondary"
                      >
                        <span className="truncate">{titleFor(item.cluster)}</span>
                        <span className="shrink-0 text-cafe-muted">{item.members.length} 个会话</span>
                      </div>
                    );
                  }
                  if (item.kind === 'thread') return renderThread(item.thread, false);
                  if (item.kind === 'cluster-member') return renderThread(item.member, true);
                  return null;
                })
              )}
            </div>

            {saveError && (
              <p role="alert" className="border-t border-cafe-subtle px-4 py-2 text-xs text-conn-red-text">
                {saveError}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-cafe-subtle px-4 py-3">
              <span className="text-xs text-cafe-muted" data-testid="thread-picker-count">
                已选 {draft.size} 个
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="thread-picker-cancel"
                  className="rounded-lg px-3 py-1.5 text-xs text-cafe-secondary hover:bg-cafe-surface-elevated"
                  onClick={closePicker}
                  disabled={saving}
                >
                  取消
                </button>
                <button
                  type="button"
                  data-testid="thread-picker-save"
                  className="console-button-primary text-xs disabled:opacity-40"
                  onClick={() => void save()}
                  disabled={saving || !choose}
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
