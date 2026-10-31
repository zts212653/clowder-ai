'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { OwnerCurrentPagePicker } from './OwnerCurrentPagePicker';

interface Consent {
  previewId: string;
  pageUrl: string;
  field: string;
  fieldSelector: string;
  readbackSelector: string;
  operation?: 'click' | 'fill';
  value?: string;
  expectedReadback?: string;
  restoreValue?: string;
  selection?: { servedModel: string };
  expiresAtMs: number;
  permissionScope: string;
}

interface Outcome {
  status: 'applied' | 'restored' | 'no_effect' | 'cancelled' | 'denied' | 'unknown';
  forward: { status: string; before: string; after?: string };
  rollback?: { status: string; after?: string };
  receiptPersistence?: 'stored' | 'unconfirmed';
}

type View =
  | { kind: 'unavailable' }
  | {
      kind: 'available';
      requestMessageId: string;
      requestText: string;
      pageUrl: string;
      pageSelection?: boolean;
      state: 'ready' | 'inspecting' | 'awaiting_consent' | 'executing' | 'settled';
      preview?: Consent;
      result?: Outcome;
      resultRequestMessageId?: string;
      resultObservedAtMs?: number;
      selectionNotice?: { kind: 'ask' | 'none' | 'unavailable'; reason: string; selection?: { servedModel: string } };
    };

const ROUTE = '/api/concierge/page-action';

function resultCopy(status: Outcome['status']): string {
  switch (status) {
    case 'applied':
      return '已核对页面修改，结果保留在原页面。';
    case 'restored':
      return '已核对写入并恢复原值。';
    case 'no_effect':
      return '未观察到页面变化。';
    case 'unknown':
      return '页面或恢复结果未确认；不会自动重试。';
    default:
      return '页面操作未执行。';
  }
}

/** A page is inspected only after the owner clicks; confirmation sends an opaque preview ID. */
export function OwnerPageActionControl() {
  const [view, setView] = useState<View | null>(null);
  const [working, setWorking] = useState<'inspect' | 'confirm' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusUnconfirmed, setStatusUnconfirmed] = useState(false);

  const refresh = useCallback(async (afterCurrentGet = false) => {
    try {
      const response = await apiFetch(ROUTE, undefined, { afterCurrentGet });
      if (!response.ok) throw new Error('Owner page action status unavailable');
      const next = (await response.json()) as View;
      setView(next.kind === 'available' || next.kind === 'unavailable' ? next : { kind: 'unavailable' });
      setStatusUnconfirmed(false);
    } catch {
      setStatusUnconfirmed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const inspect = async () => {
    if (view?.kind !== 'available' || view.state !== 'ready' || working) return;
    setWorking('inspect');
    setError(null);
    try {
      const response = await apiFetch(`${ROUTE}/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestMessageId: view.requestMessageId }),
      });
      if (!response.ok) setError('当前请求或页面已变化。请刷新后重新检查。');
    } catch {
      setError('页面检查状态未确认。请刷新后重试。');
    } finally {
      await refresh(true);
      setWorking(null);
    }
  };

  const confirm = async () => {
    if (view?.kind !== 'available' || view.state !== 'awaiting_consent' || !view.preview || working) return;
    setWorking('confirm');
    setError(null);
    try {
      const response = await apiFetch(`${ROUTE}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewId: view.preview.previewId }),
      });
      if (!response.ok) setError('一次性授权未获确认；页面结果未知时不会自动重试。');
    } catch {
      setError('执行结果未确认；请查看页面与回读，不要重复点击允许。');
    } finally {
      await refresh(true);
      setWorking(null);
    }
  };

  const cancel = async () => {
    if (view?.kind !== 'available' || !view.preview) return;
    setError(null);
    try {
      const response = await apiFetch(ROUTE, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewId: view.preview.previewId }),
      });
      if (!response.ok) setError('撤销未确认；停止 Live 通话可立即撤销 Host 授权。');
    } catch {
      setError('撤销状态未确认；停止 Live 通话可立即撤销 Host 授权。');
    } finally {
      await refresh(true);
    }
  };

  if (view?.kind !== 'available') return null;
  const preview = view.preview;
  return (
    <section
      aria-label="页面操作授权"
      className="max-h-60 overflow-y-auto border-b border-cafe-divider bg-cafe-surface px-3 py-2 text-xs text-cafe-secondary"
    >
      <div className="flex items-center justify-between gap-2">
        <strong className="text-cafe-primary">一次性页面操作</strong>
        {view.state === 'ready' && (
          <button
            type="button"
            onClick={() => void inspect()}
            disabled={working !== null || statusUnconfirmed || Boolean(view.pageSelection && !view.pageUrl)}
            className="rounded border border-cafe-divider px-2 py-1 disabled:opacity-50"
          >
            {working === 'inspect' ? '检查中…' : view.pageSelection ? '重新检查当前页面' : '检查具名页面'}
          </button>
        )}
      </div>
      <p className="mt-1 break-words">当前直接请求：{view.requestText}</p>
      <p className="break-all">目标页面：{view.pageUrl || '请先选择当前页面'}</p>
      {view.pageSelection && (
        <OwnerCurrentPagePicker
          key={view.requestMessageId}
          requestMessageId={view.requestMessageId}
          disabled={working !== null || statusUnconfirmed || view.state === 'executing' || view.state === 'inspecting'}
          onSelected={() => refresh(true)}
        />
      )}
      {preview && (
        <div className="mt-2 space-y-1 rounded border border-cafe-divider p-2">
          <p>
            {preview.operation === 'click' ? '点击' : '字段'}：{preview.field}
            {!view.pageSelection && `（${preview.fieldSelector}）`}
          </p>
          {preview.selection && <p>Jev 已选择此目标，尚需你的确认。</p>}
          {preview.value !== undefined && <p className="break-words">填入：{preview.value}</p>}
          <p className="break-all">
            {preview.expectedReadback === undefined
              ? '点击后读取该控件的实际状态；未能确认业务结果时不会宣称成功。'
              : view.pageSelection
                ? `预期字段值：${preview.expectedReadback}`
                : `预期回读（${preview.readbackSelector}）：${preview.expectedReadback}`}
          </p>
          {preview.restoreValue !== undefined ? (
            <p>恢复原值：{preview.restoreValue === '' ? '空值' : preview.restoreValue}</p>
          ) : (
            <p>这次修改会保留；改意时请提出新的请求。</p>
          )}
          <p>
            读取范围：只检查上述字段、目标及页面回读。授权仅此一次，{new Date(preview.expiresAtMs).toLocaleTimeString()}{' '}
            失效。
          </p>
          <div className="flex gap-2 pt-1">
            {view.state === 'awaiting_consent' && (
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={working !== null || statusUnconfirmed}
                className="rounded bg-cafe-accent px-2 py-1 text-[var(--cafe-accent-foreground)] disabled:opacity-50"
              >
                {preview.restoreValue !== undefined ? '允许一次并恢复' : '允许这次修改'}
              </button>
            )}
            <button
              type="button"
              onClick={() => void cancel()}
              className="rounded border border-cafe-divider px-2 py-1"
            >
              取消／撤销
            </button>
          </div>
        </div>
      )}
      {view.state === 'inspecting' && <p className="mt-1">正在检查具名页面，尚未写入。</p>}
      {view.selectionNotice && (
        <p role="status" className="mt-1">
          {view.selectionNotice.reason}
        </p>
      )}
      {view.state === 'executing' && <p className="mt-1">正在执行并核对回读；撤销后结果仍可能未知。</p>}
      {view.result && (
        <output className="mt-1 block">
          {view.resultRequestMessageId && view.resultRequestMessageId !== view.requestMessageId
            ? '此前核对的结果：'
            : ''}
          {resultCopy(view.result.status)}
          {view.resultObservedAtMs && `（核对时间 ${new Date(view.resultObservedAtMs).toLocaleTimeString()}）`}
        </output>
      )}
      {view.result?.receiptPersistence === 'unconfirmed' && (
        <p role="alert">回执保存尚未确认；不要重复执行页面修改。</p>
      )}
      {statusUnconfirmed && (
        <p role="alert" className="mt-1">
          Host 状态未确认；请停止 Live 通话撤销授权。
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1">
          {error}
        </p>
      )}
    </section>
  );
}
