'use client';
import type { AssetCanonItem, WorkContextRecord } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { useCanonBindingChoices } from './AssetCanonBindingChoices';
import { canonCommand } from './asset-canon-client';

export function AssetCanonSupersession({
  item,
  candidates,
  record,
  threadId,
  busy,
  act,
  mutate,
}: {
  item: AssetCanonItem;
  candidates: AssetCanonItem[];
  record: WorkContextRecord;
  threadId: string;
  busy: boolean;
  act: (operation: () => Promise<unknown>) => Promise<boolean>;
  mutate: (intent: Record<string, unknown>) => Promise<unknown>;
}) {
  const [oldRef, setOldRef] = useState(''),
    [old, setOld] = useState<AssetCanonItem>();
  const [reason, setReason] = useState(''),
    [error, setError] = useState('');
  const bindings = useCanonBindingChoices(old?.bindings ?? [], [item], reason);
  useEffect(() => {
    const abort = new AbortController();
    setOld(undefined);
    setError('');
    if (oldRef)
      void canonCommand<AssetCanonItem>(threadId, { action: 'read-asset', indexedVersionRef: oldRef }, abort.signal)
        .then((value) => {
          if (!abort.signal.aborted) setOld(value);
        })
        .catch(() => {
          if (!abort.signal.aborted) setError('旧件和用途暂时无法读取，请重新选择。');
        });
    return () => abort.abort();
  }, [threadId, oldRef]);
  return (
    <form
      aria-label="取代旧素材"
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!old?.canWrite || !bindings.ready || !reason.trim()) return;
        void act(() =>
          mutate({
            action: 'supersede-asset',
            mode: 'replace',
            fromVersionRef: old.record.indexedVersionRef,
            toVersionRef: item.record.indexedVersionRef,
            expectedFromRevision: old.record.revision,
            expectedToRevision: item.record.revision,
            reason,
            bindings: bindings.dispositions,
            context: { reference: record.reference, metadataRevision: record.metadataRevision },
          }),
        ).then((ok) => {
          if (ok) {
            setOldRef('');
            setReason('');
          }
        });
      }}
    >
      <select
        required
        aria-label="被取代的旧件"
        value={oldRef}
        onChange={(e) => setOldRef(e.target.value)}
        className="w-full rounded border border-cafe-subtle bg-cafe-surface p-2"
      >
        <option value="">从这支片的同类素材选</option>
        {candidates
          .filter(
            (c) =>
              c.record.kind === item.record.kind &&
              c.record.indexedVersionRef !== item.record.indexedVersionRef &&
              !c.record.supersededBy,
          )
          .map((c) => (
            <option key={c.record.indexedVersionRef} value={c.record.indexedVersionRef}>
              {c.record.name}
            </option>
          ))}
      </select>
      {oldRef && !old && !error ? <p className="text-xs">正在核对旧件及其用途…</p> : null}
      {old && !old.canWrite ? <p className="text-xs">当前无权修改这件原件。</p> : null}
      <label>
        为什么
        <input
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1 w-full rounded border border-cafe-subtle p-2"
        />
      </label>
      {bindings.fields}
      <button
        className="rounded border border-cafe-subtle px-2 py-1"
        disabled={busy || !old?.canWrite || !bindings.ready || !reason.trim()}
      >
        记下取代
      </button>
      {error ? (
        <p role="alert" className="text-xs">
          {error}
        </p>
      ) : null}
    </form>
  );
}
