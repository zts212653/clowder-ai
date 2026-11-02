import { splitProfileBody } from '@cat-cafe/shared/profile-opening-reference';
import { useEffect, useRef } from 'react';
import { capsulePrimary, capsuleSecondary } from './MemoryCapsuleEditor';
import type { ProfileMemoryRead } from './owner-memory-read';
import type { MemoryOwnerActionState } from './use-memory-owner-action';

export function MemoryProfileEditor({
  entry,
  value,
  change,
  cancel,
  action,
}: {
  entry: ProfileMemoryRead;
  value: string;
  change: (value: string) => void;
  cancel: () => void;
  action: MemoryOwnerActionState;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
    field.current?.scrollIntoView?.({ block: 'center' });
  }, []);
  const original = splitProfileBody(entry.content);
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim())
          action.submit({
            action: 'replace_content',
            expectedRevision: entry.revision,
            content: original.prefix + value,
          });
      }}
    >
      <label className="block text-compact">
        <span className="sr-only">画像内容</span>
        <textarea
          ref={field}
          aria-label="画像内容"
          required
          maxLength={20000}
          value={value}
          disabled={action.busy || action.retryable}
          onChange={(event) => change(event.target.value)}
          className="min-h-64 w-full resize-y rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-3 text-sm leading-relaxed focus:border-cafe-accent"
        />
      </label>
      <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center justify-between gap-3 rounded-b-xl border border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] px-4 py-3 md:-mx-6 md:-mb-6 md:px-6">
        <p className="text-xs text-cafe-muted">{value !== original.body ? '有修改还没保存' : '没有改动'}</p>
        <div className="flex gap-2">
          <button type="button" disabled={action.busy} onClick={cancel} className={capsuleSecondary}>
            放弃修改
          </button>
          <button type="submit" disabled={action.blocked} className={capsulePrimary}>
            保存
          </button>
        </div>
      </div>
    </form>
  );
}
