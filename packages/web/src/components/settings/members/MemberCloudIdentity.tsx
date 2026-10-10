'use client';
import { useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { MemberText } from './MemberRuntimeFields';

export function MemberCloudIdentity({
  cat,
  onSaved,
  t,
}: {
  cat: CatData;
  onSaved: (cat: CatData) => Promise<void>;
  t: MemberText;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(`/api/cats/${cat.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restoreBuiltinCloudIdentity: true }),
      });
      const body = (await res.json()) as { cat: CatData; error?: string };
      if (!res.ok) throw new Error(body.error || '恢复失败');
      await onSaved(body.cat);
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 text-sm">
      <p>
        {t(
          '此成员的云端接入身份受保护，可修改身份、语音和外观。',
          'This cloud identity is protected. Profile, voice and appearance remain editable.',
        )}
      </p>
      {cat.identityProtection?.state === 'drifted' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void restore()}
          className="min-h-11 rounded-lg border px-4"
        >
          {t('恢复内置云端身份', 'Restore built-in cloud identity')}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
