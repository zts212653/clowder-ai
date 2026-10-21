'use client';
import { useState } from 'react';

export function MemberDeleteButton({
  disabled,
  onDelete,
  t,
}: {
  disabled: boolean;
  onDelete: () => Promise<void>;
  t: (zh: string, en: string) => string;
}) {
  const [pending, setPending] = useState(false);
  const remove = async () => {
    setPending(true);
    try {
      await onDelete();
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="mb-4 flex justify-end">
      <button
        type="button"
        disabled={disabled || pending}
        onClick={() => void remove()}
        className="min-h-10 rounded-lg px-3 text-sm text-conn-red-text disabled:opacity-50"
      >
        {pending ? t('正在处理…', 'Working…') : t('删除成员', 'Delete member')}
      </button>
    </div>
  );
}
