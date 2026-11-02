'use client';
import type { AssetCanonItem, AssetCanonRecord, WorkContextRecord } from '@cat-cafe/shared';
import { useCanonBindingChoices } from './AssetCanonBindingChoices';
import { canonStatusLabel } from './asset-canon-presentation';

export function AssetCanonJudgment({
  item,
  status,
  setStatus,
  reason,
  setReason,
  candidates,
  record,
  act,
  mutate,
  busy,
}: {
  item: AssetCanonItem;
  status: AssetCanonRecord['status'];
  setStatus: (status: AssetCanonRecord['status']) => void;
  reason: string;
  setReason: (reason: string) => void;
  candidates: AssetCanonItem[];
  record: WorkContextRecord;
  busy: boolean;
  act: (operation: () => Promise<unknown>) => Promise<boolean>;
  mutate: (intent: Record<string, unknown>) => Promise<unknown>;
}) {
  const bindings = useCanonBindingChoices(
    status !== 'canonical' ? item.bindings : [],
    candidates.filter((c) => c.record.indexedVersionRef !== item.record.indexedVersionRef),
    reason,
  );
  return (
    <form
      aria-label="标记素材"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!status || !reason.trim() || !bindings.ready) return;
        void act(() =>
          mutate({
            action: 'set-asset-status',
            indexedVersionRef: item.record.indexedVersionRef,
            expectedRevision: item.record.revision,
            status,
            reason,
            bindings: bindings.dispositions,
            context: { reference: record.reference, metadataRevision: record.metadataRevision },
          }),
        ).then((ok) => {
          if (ok) setReason('');
        });
      }}
    >
      <div className="flex rounded-lg bg-cafe-surface-elevated p-1" role="group" aria-label="素材标记">
        {(['canonical', 'experimental', 'failed'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            className={`flex-1 rounded px-1 py-2 text-xs ${status === value ? 'bg-cafe-surface' : 'text-cafe-muted'}`}
            onClick={() => setStatus(value)}
          >
            {canonStatusLabel[value]}
          </button>
        ))}
      </div>
      <label className="block text-cafe-muted">
        为什么
        <textarea
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1 w-full rounded-lg border border-cafe-subtle bg-cafe-surface p-2 text-cafe-primary focus:border-[var(--evolution-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--evolution-focus)]"
        />
      </label>
      {bindings.fields}
      <button
        className="rounded bg-cafe-accent px-3 py-2 text-white"
        disabled={busy || !status || !reason.trim() || !bindings.ready}
      >
        记下
      </button>
    </form>
  );
}
