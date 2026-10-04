'use client';

import { useRef, useState } from 'react';
import type { ReviewMarkupMark } from './review-markup-draft';

/** A receipt retires only the snapshot it submitted; later strokes stay in the local draft. */
export function useArtworkSave(
  marks: readonly ReviewMarkupMark[],
  onSave: (submitted: readonly ReviewMarkupMark[]) => Promise<boolean>,
  onComplete: () => void,
) {
  const [saving, setSaving] = useState(false);
  const [savingIds, setSavingIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const held = useRef(false);
  const current = useRef(marks);
  current.current = marks;

  const save = () => {
    if (!marks.length || held.current) return;
    const submitted = [...marks];
    const snapshot = new Map(submitted.map((mark) => [mark.id, JSON.stringify(mark)]));
    held.current = true;
    setSaving(true);
    setSavingIds(submitted.map((mark) => mark.id));
    setNotice(null);
    void onSave(submitted)
      .then((saved) => {
        if (!saved) {
          setNotice('保存结果待核对；草稿仍保留。');
          return;
        }
        setNotice('本次标记已保存。');
        if (current.current.every((mark) => snapshot.get(mark.id) === JSON.stringify(mark))) onComplete();
      })
      .catch(() => setNotice('保存结果待核对；草稿仍保留。'))
      .finally(() => {
        held.current = false;
        setSaving(false);
        setSavingIds([]);
      });
  };
  return { saving, savingIds, notice, save };
}
