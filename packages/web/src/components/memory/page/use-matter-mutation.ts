'use client';
import type { MatterMutationReceipt, MatterWriteInput } from '@cat-cafe/shared';
import { useRef, useState } from 'react';
import { notifyMatterMemoryChanged } from '@/hooks/matter-memory-events';
import { apiFetch } from '@/utils/api-client';

type Change = MatterWriteInput extends infer T ? (T extends MatterWriteInput ? Omit<T, 'requestId'> : never) : never;
export function useMatterMutation(onApplied: (receipt: MatterMutationReceipt) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<MatterWriteInput | null>(null);
  const running = useRef(false);
  const execute = async () => {
    if (!pending.current || running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/memory/matters/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pending.current),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(
          body.error === 'stale_revision'
            ? '内容已更新，请重新读取。'
            : body.error === 'not_available'
              ? '来源已不可用，请重新读取。'
              : '修改未成功，请检查内容后重试。',
        );
        if (response.status < 500) pending.current = null;
        return;
      }
      if (!body.matter || !['applied', 'forgotten'].includes(body.outcome)) throw new Error('Unconfirmed response');
      pending.current = null;
      notifyMatterMemoryChanged();
      onApplied(body as MatterMutationReceipt);
    } catch {
      setError('尚未确认修改结果，可以重试这次操作。');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return {
    busy,
    error,
    retryable: Boolean(error && pending.current),
    retry: execute,
    submit: (change: Change) => {
      if (running.current || pending.current) return;
      pending.current = { ...change, requestId: crypto.randomUUID() } as MatterWriteInput;
      void execute();
    },
  };
}
