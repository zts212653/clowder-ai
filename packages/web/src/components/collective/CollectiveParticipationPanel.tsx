'use client';

import type { CollectiveEventEnvelope } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CollectiveWorkRequests } from './CollectiveWorkRequests';

export interface ParticipationView {
  revision: number;
  published: boolean;
  cats: { id: string; displayName: string; supported: boolean }[];
  bindings: Record<
    string,
    {
      catId: string;
      threadId: string;
      participation?: { channelIds: string[] };
      standingWork?: { requestingHumanIds: string[]; threadId: string; expiresAt: string | null };
    }
  >;
  threads: { id: string; title?: string }[];
  requests: { event: CollectiveEventEnvelope; messageId?: string; delivery: string; failure?: { code: string } }[];
  tasks: {
    id: string;
    title: string;
    threadId: string;
    status: string;
    revision: number;
    closure: string;
    sourceRefs: string[];
  }[];
}
const control =
  'min-w-0 max-w-full rounded-lg border border-[var(--console-border-soft)] bg-[var(--cafe-surface-sunken)] px-3 py-2 text-sm text-cafe-primary';
const action =
  'rounded-lg bg-cafe-accent px-3 py-2 text-sm font-semibold text-[var(--cafe-accent-foreground)] disabled:opacity-50';

export function CollectiveParticipationPanel({ connectionId }: { readonly connectionId: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ParticipationView>();
  const [catId, setCatId] = useState('');
  const [channelId, setChannelId] = useState('general');
  const [standingHuman, setStandingHuman] = useState('');
  const [privateThread, setPrivateThread] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const busyRef = useRef(false);
  const base = `/api/plugins/collective-connector/${encodeURIComponent(connectionId)}`;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const response = await apiFetch(`${base}/participation`, { signal }, { afterCurrentGet: true });
      if (!response.ok) throw new Error('暂时无法读取参与设置，请重试。');
      const data = (await response.json()) as ParticipationView;
      if (signal?.aborted) return;
      setView(data);
      setError(undefined);
    },
    [base],
  );
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    const refresh = () =>
      void load(abort.signal).catch((cause) => {
        if (!abort.signal.aborted) setError(cause.message);
      });
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [load, open]);
  const mutate = async (path: string, body: Record<string, unknown>, method = 'POST') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const operationKey =
        path === '/work/resume'
          ? `collective-work-resume:${connectionId}:${body.taskId}:${body.observedRevision}`
          : undefined;
      if (operationKey) {
        const requestId = localStorage.getItem(operationKey) ?? crypto.randomUUID();
        localStorage.setItem(operationKey, requestId);
        body = { ...body, requestId };
      }
      const response = await apiFetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as { code?: string; result?: string; disposition?: string };
      if (!response.ok) throw new Error(actionError(result.code, result.result));
      if (operationKey) localStorage.removeItem(operationKey);
      setNotice(
        path === '/participation'
          ? '参与设置已发布。'
          : result.disposition === 'queued'
            ? '已进入猫的私人执行队列；完成情况会留在原工作里。'
            : '已恢复原执行记录；完成情况可以在私人工作里查看。',
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未完成，请重试。');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const selectedCat = view?.cats.find((cat) => cat.id === catId);
  const binding = Object.values(view?.bindings ?? {}).find((item) => item.catId === catId);
  const channels = [
    ...new Set([
      'general',
      ...(view?.requests.flatMap((item) => (item.event.location ? [item.event.location.channelId] : [])) ?? []),
      ...Object.values(view?.bindings ?? {}).flatMap((item) => item.participation?.channelIds ?? []),
    ]),
  ];
  const humans = new Map(
    (view?.requests ?? []).flatMap((item) =>
      item.event.actor.kind === 'human' ? [[item.event.actor.humanId, item.event.actor.displayName] as const] : [],
    ),
  );
  const updateParticipation = (enabled: boolean) =>
    void mutate(
      '/participation',
      {
        catId,
        channelIds: [channelId],
        enabled,
        expectedRevision: view?.revision,
        ...(enabled && standingHuman
          ? {
              standingWork: {
                requestingHumanIds: [standingHuman],
                expiresAt: null,
                ...(privateThread ? { threadId: privateThread } : {}),
              },
            }
          : {}),
      },
      'PUT',
    );
  return (
    <section className="w-full rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] text-cafe-primary shadow-[var(--console-elevation-2)]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="w-full px-4 py-3 text-left text-sm font-semibold"
      >
        带猫加入{open ? ' · 收起' : ''}
      </button>
      {open && (
        <div className="max-h-[70vh] space-y-4 overflow-y-auto border-t border-[var(--console-border-soft)] p-4">
          {!view ? (
            <p className="text-sm text-cafe-muted">{error ?? '正在读取参与设置…'}</p>
          ) : (
            <>
              <p className="text-xs leading-5 text-cafe-secondary">选择家里的猫，让它在频道里读取公开上下文并回应。</p>
              <label className="grid gap-1 text-xs">
                带哪只猫
                <select
                  aria-label="选择参与的猫"
                  className={control}
                  value={catId}
                  onChange={(event) => {
                    const id = event.target.value;
                    setCatId(id);
                    const current = Object.values(view.bindings).find((item) => item.catId === id);
                    setChannelId(current?.participation?.channelIds[0] ?? 'general');
                    setStandingHuman(current?.standingWork?.requestingHumanIds[0] ?? '');
                    setPrivateThread(current?.standingWork?.threadId ?? '');
                  }}
                >
                  <option value="">选择一只猫</option>
                  {view.cats.map((cat) => (
                    <option key={cat.id} value={cat.id} disabled={!cat.supported}>
                      {cat.displayName}
                      {cat.supported ? '' : ' · 暂不支持公共参与'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs">
                公开频道
                <select className={control} value={channelId} onChange={(event) => setChannelId(event.target.value)}>
                  {channels.map((id) => (
                    <option key={id}>{id}</option>
                  ))}
                </select>
              </label>
              {binding?.participation && (
                <p className="text-xs text-cafe-secondary">
                  {view.published ? '已公开参与' : '设置已保存，公开状态尚未确认'}
                </p>
              )}
              <details className="text-xs text-cafe-secondary">
                <summary className="cursor-pointer">私人执行授权</summary>
                <div className="mt-3 space-y-3">
                  <p>默认每次由你安排私人执行。也可以预先允许指定成员在这个频道明确发出的持续委托。</p>
                  <label className="grid gap-1">
                    接受谁的持续委托
                    <select
                      className={control}
                      value={standingHuman}
                      onChange={(event) => setStandingHuman(event.target.value)}
                    >
                      <option value="">每次由我安排</option>
                      {[...humans].map(([id, name]) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {standingHuman && (
                    <>
                      <p>允许所选成员的持续委托进入猫的私人工作，可使用该工作空间的能力，直到你撤回。</p>
                      <label className="grid gap-1">
                        私人工作放在哪里
                        <select
                          className={control}
                          value={privateThread}
                          onChange={(event) => setPrivateThread(event.target.value)}
                        >
                          <option value="">新建私人工作对话</option>
                          {view.threads.map((thread) => (
                            <option key={thread.id} value={thread.id}>
                              {thread.title || '未命名对话'}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                </div>
              </details>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={action}
                  disabled={busy || !selectedCat?.supported}
                  onClick={() => updateParticipation(true)}
                >
                  {busy ? '保存中…' : binding?.participation ? '更新参与设置' : '带它加入'}
                </button>
                {binding?.participation && (
                  <button type="button" className={control} disabled={busy} onClick={() => updateParticipation(false)}>
                    退出参与
                  </button>
                )}
              </div>
              <CollectiveWorkRequests
                requests={view.requests}
                tasks={view.tasks}
                busy={busy}
                mutate={mutate}
                control={control}
              />
            </>
          )}
          {error && (
            <p role="alert" className="text-xs text-conn-red-text">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-xs text-cafe-secondary">
              {notice}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function actionError(code?: string, result?: string) {
  if (code === 'PARTICIPATION_REVISION_CONFLICT') return '参与设置已被更新，请重新展开后再操作。';
  if (code === 'PARTICIPATION_REVOKED' || code === 'OWNER_ADMISSION_UNAVAILABLE')
    return '当前授权已失效。原工作仍保留，可以打开私人工作安排后续。';
  if (code === 'RETURN_UNAVAILABLE') return '原请求暂不可用，无法继续执行或回流。原工作仍保留。';
  if (result === 'needs_clarification') return '这项请求包含期限，请填写截止时间后再安排。';
  return '操作未完成，请检查连接和当前参与设置后重试。';
}
