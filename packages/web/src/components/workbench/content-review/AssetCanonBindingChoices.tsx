'use client';
import type {
  AssetBindingDisposition,
  AssetCanonItem,
  CharacterAssetBinding,
  CharacterAssetUse,
} from '@cat-cafe/shared';
import { useState } from 'react';
import { getCachedCats } from '@/hooks/useCatData';

function sameUse(a: CharacterAssetUse, b: CharacterAssetUse) {
  const sameSubject =
    a.subjectRef.kind === 'member'
      ? b.subjectRef.kind === 'member' && a.subjectRef.catId === b.subjectRef.catId
      : b.subjectRef.kind === 'series' &&
        a.subjectRef.seriesKey === b.subjectRef.seriesKey &&
        a.subjectRef.characterKey === b.subjectRef.characterKey;
  return (
    sameSubject &&
    a.representation === b.representation &&
    a.styleKey === b.styleKey &&
    a.role === b.role &&
    a.actionKey === b.actionKey
  );
}
function compatible(item: AssetCanonItem, binding: CharacterAssetBinding) {
  const record = item.record,
    slot = binding.slot;
  if (record.status !== 'canonical' || record.supersededBy || item.fileState !== 'available') return false;
  return slot.role === 'member-avatar'
    ? record.version.mediaType.startsWith('image/') &&
        record.applicability.some(
          (use) =>
            use.role === 'avatar' &&
            (use.subjectRef.kind === 'member'
              ? use.subjectRef.catId === slot.catId
              : binding.memberCatId === slot.catId),
        )
    : record.applicability.some((use) => sameUse(use, slot));
}
function bindingLabel(binding: CharacterAssetBinding) {
  const slot = binding.slot;
  const member = (catId: string) => getCachedCats().find((cat) => cat.id === catId)?.nickname ?? catId;
  if (slot.role === 'member-avatar') return `${member(slot.catId)} · 成员头像`;
  const who =
    slot.subjectRef.kind === 'member'
      ? member(slot.subjectRef.catId)
      : `${slot.subjectRef.seriesKey} · ${slot.subjectRef.characterKey}`;
  return `${who} · ${{ avatar: '头像', portrait: '立绘', action: '动作', reference: '参考' }[slot.role]} · ${slot.representation} · ${slot.styleKey}${slot.actionKey ? ` · ${slot.actionKey}` : ''}`;
}
export function useCanonBindingChoices(bindings: CharacterAssetBinding[], targets: AssetCanonItem[], reason: string) {
  const key = JSON.stringify(bindings.map((b) => [b.bindingRef, b.bindingRevision]));
  const [selection, setSelection] = useState<{ key: string; values: Record<string, string> }>({ key, values: {} });
  const values = selection.key === key ? selection.values : {};
  const dispositions: AssetBindingDisposition[] = [];
  let ready = true;
  for (const binding of bindings) {
    const value = values[binding.bindingRef];
    const target = targets.find((t) => t.record.indexedVersionRef === value && compatible(t, binding));
    if (value !== 'clear' && !target) {
      ready = false;
      continue;
    }
    dispositions.push({
      bindingRef: binding.bindingRef,
      expectedBindingRevision: binding.bindingRevision,
      indexedVersionRef: target?.record.indexedVersionRef ?? null,
      ...(target ? { expectedAssetRevision: target.record.revision } : {}),
      reason,
    });
  }
  const fields = bindings.length ? (
    <fieldset className="space-y-3 rounded border border-cafe-subtle p-2">
      <legend className="text-xs">这件素材正在用于</legend>
      <p className="text-xs text-cafe-muted">每项选择换用相容正典或解除，和这次标记一起保存；旧片原件不变。</p>
      {bindings.map((binding) => (
        <label key={binding.bindingRef} className="block text-xs">
          {bindingLabel(binding)}
          <select
            required
            data-binding-ref={binding.bindingRef}
            value={values[binding.bindingRef] ?? ''}
            className="mt-1 w-full rounded border border-cafe-subtle bg-cafe-surface p-2"
            onChange={(e) => setSelection({ key, values: { ...values, [binding.bindingRef]: e.target.value } })}
          >
            <option value="">请选择如何处理</option>
            {targets
              .filter((t) => compatible(t, binding))
              .map((t) => (
                <option key={t.record.indexedVersionRef} value={t.record.indexedVersionRef}>
                  换用 · {t.record.name.split('/').at(-1)}
                </option>
              ))}
            <option value="clear">解除这个用途</option>
          </select>
        </label>
      ))}
    </fieldset>
  ) : null;
  return { ready, dispositions, fields };
}
