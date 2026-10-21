'use client';
import { useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { useMemberText } from './editor-presentation';

/** Full values remain keyboard-accessible when the overview truncates them. */
export function MemberIdentityDetails({ cat, onEdit }: { cat: CatData; onEdit: () => void }) {
  const t = useMemberText();
  const [feedback, setFeedback] = useState('');
  const values = [
    ['ID', cat.id],
    [t('模型'), cat.defaultModel || t('跟随工具设置')],
    [t('账号'), cat.accountRef || t('跟随工具设置')],
  ];
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback(t('已复制'));
    } catch {
      setFeedback(t('复制失败，请选中文字复制'));
    }
  };
  return (
    <details className="member-identity-details">
      <summary>{t('配置详情')}</summary>
      <div className="member-full-values">
        {values.map(([label, value]) => (
          <div key={label}>
            <small>{label}</small>
            <code>{value}</code>
            <button type="button" aria-label={`${t('复制')} ${label}`} onClick={() => void copy(value)}>
              {t('复制')}
            </button>
          </div>
        ))}
        <output aria-live="polite">{feedback}</output>
        <button type="button" className="member-button" onClick={onEdit}>
          {t('编辑配置')}
        </button>
      </div>
    </details>
  );
}
