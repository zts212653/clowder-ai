'use client';
import type { DshConnectionCheckView } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { checkSavedDshMember, dshConnectionCheckMessage, readDshConnectionCheck } from './dsh-connection-check-client';

export function DshConnectionStatus({
  member,
  result,
}: {
  member: Pick<CatData, 'id' | 'configurationRevision'>;
  result?: DshConnectionCheckView;
}) {
  const [view, setView] = useState<DshConnectionCheckView>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    setView(result);
    if (result?.state === 'checking') return;
    readDshConnectionCheck(member.id).then((value) => {
      if (current) setView(value);
    });
    return () => {
      current = false;
    };
  }, [member.id, result]);
  const displayed = view ?? result;
  return (
    <section className="space-y-2 text-sm" aria-label="已保存配置的连接状态">
      <output>{displayed ? dshConnectionCheckMessage(displayed) : '正在读取已保存配置的检查记录…'}</output>
      <button
        type="button"
        disabled={busy}
        className="min-h-10 text-cafe-accent"
        onClick={() => {
          setBusy(true);
          readDshConnectionCheck(member.id)
            .then(setView)
            .finally(() => setBusy(false));
        }}
      >
        刷新状态
      </button>
      {displayed?.state !== 'checking' && (
        <button
          type="button"
          disabled={busy}
          className="min-h-10 text-cafe-accent"
          onClick={() => {
            setBusy(true);
            setView({ state: 'checking' });
            checkSavedDshMember(member)
              .then(setView)
              .finally(() => setBusy(false));
          }}
        >
          检查连接（可能产生模型费用）
        </button>
      )}
    </section>
  );
}
