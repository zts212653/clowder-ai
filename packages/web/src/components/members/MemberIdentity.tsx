'use client';
import { useState } from 'react';
import { useMemberText } from './editor-presentation';

export function MemberIdentity({ id }: { id: string }) {
  const t = useMemberText();
  const [feedback, setFeedback] = useState('');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setFeedback(t('已复制'));
    } catch {
      setFeedback(t('复制失败，请选中文字复制'));
    }
  };
  return (
    <div className="member-identity">
      <span>ID</span>
      <code>{id}</code>
      <button type="button" className="member-button" aria-label={`${t('复制')} ID`} onClick={() => void copy()}>
        {t('复制')}
      </button>
      <output aria-live="polite">{feedback}</output>
    </div>
  );
}
