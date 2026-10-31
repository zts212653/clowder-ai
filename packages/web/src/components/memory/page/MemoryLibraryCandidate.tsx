'use client';
import { useRef, useState } from 'react';
import { writeLibraryCandidate } from './library-candidate-actions';
import { LIBRARY_KINDS, libraryVisibility, widensLibraryVisibility } from './library-labels';
import type { LibraryCandidate, LibraryCollection } from './MemoryLibrary';
import { formatMemoryDate } from './use-memory-read';

const buttonClass = 'rounded-lg border border-cafe-subtle px-3 py-1.5 text-compact disabled:opacity-50';
export function MemoryLibraryCandidate({
  item,
  collections,
  defaultTargetCollectionId,
  processed,
  onChanged,
}: {
  item: LibraryCandidate;
  collections: LibraryCollection[];
  defaultTargetCollectionId: string | null;
  processed: boolean;
  onChanged: (message: string) => void;
}) {
  const targets = collections.filter((c) => c.status !== 'archived' && c.readStatus === 'ready');
  const [targetId, setTargetId] = useState<string | null>(null);
  const ordinarySource =
    item.sourceVisibility == null || item.sourceVisibility === 'public' || item.sourceVisibility === 'internal';
  const selectedId = targetId ?? (ordinarySource ? defaultTargetCollectionId : null) ?? '';
  const target = targets.find((c) => c.id === selectedId);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const widening = target && widensLibraryVisibility(item.sourceVisibility, target.visibility);

  async function submit(action: 'approve' | 'reject', confirmed = false) {
    if (inFlight.current || error || (action === 'approve' && !target)) return;
    if (action === 'approve' && widening && !confirmed) {
      setConfirming(true);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const outcome = await writeLibraryCandidate(action, item.id, target, confirmed);
      setConfirming(outcome.kind === 'confirm');
      if (outcome.kind === 'blocked') setError(outcome.message);
      if (outcome.kind === 'done') {
        setResult(outcome.message);
        onChanged(outcome.message);
      }
    } catch {
      setError('没有确认操作成功。请重读待收录记录后再试。');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <article className="rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-compact text-cafe-muted">
        <span>
          {LIBRARY_KINDS[item.kind] ?? '资料'} · {formatMemoryDate(item.createdAt)}
        </span>
        <span>{item.state}</span>
      </div>
      <p className="mt-3 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-[1.55]">{item.content}</p>
      <details className="mt-2 text-compact text-cafe-secondary">
        <summary className="cursor-pointer text-cafe-accent">展开提议</summary>
        <p className="mt-2 whitespace-pre-wrap break-words">{item.content}</p>
      </details>
      <p className="mt-3 text-compact text-cafe-muted">
        {item.collectionName ? `来源资料库：${item.collectionName}` : '来源资料库没有记录下来'}
      </p>
      {!processed && !result && (
        <div className="mt-3 space-y-3">
          <label className="block text-compact text-cafe-secondary">
            收录到
            <select
              aria-label="目标资料库"
              value={target?.id ?? ''}
              disabled={busy}
              onChange={(e) => {
                setTargetId(e.target.value);
                setConfirming(false);
              }}
              className="mt-1 block w-full rounded-lg border border-cafe-subtle bg-[var(--console-field-bg)] px-3 py-2 text-sm"
            >
              <option value="">{targets.length ? '请选择资料库' : '还没有可收录的资料库'}</option>
              {targets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {libraryVisibility(c.visibility)}
                </option>
              ))}
            </select>
          </label>
          {target && (
            <p className="text-compact text-cafe-secondary">
              收录到 {target.name} · {libraryVisibility(target.visibility)}可见
            </p>
          )}
          {confirming && (
            <div className="rounded-lg border border-cafe-subtle p-3 text-compact" role="alert">
              <p>
                可见范围将扩大：{libraryVisibility(item.sourceVisibility)} → {libraryVisibility(target?.visibility)}
                。收录到 {target?.name} 后，更多人可能读到这条内容。
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy || !!error}
                  onClick={() => void submit('approve', true)}
                >
                  确认扩大可见范围并收录
                </button>
                <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirming(false)}>
                  取消
                </button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={busy || !target || confirming || !!error}
              onClick={() => void submit('approve')}
            >
              {busy ? '处理中…' : '收录'}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={busy || !!error}
              onClick={() => void submit('reject')}
            >
              不收录
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="mt-3 text-compact text-cafe-muted" role="alert">
          {error}
          <button
            type="button"
            className="ml-2 text-cafe-accent underline"
            onClick={() => onChanged('已请求重读待收录记录。')}
          >
            重读待收录记录
          </button>
        </p>
      )}
      {result && <output className="mt-3 block text-compact text-cafe-secondary">{result}</output>}
    </article>
  );
}
