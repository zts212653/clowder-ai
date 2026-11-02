import {
  splitUserCapsule,
  USER_CAPSULE_CHAR_LIMIT,
  userCapsuleCharacterCount,
} from '@cat-cafe/shared/profile-contract';
import { useEffect, useRef } from 'react';
import type { MemoryOwnerActionState } from './use-memory-owner-action';

export const capsulePrimary =
  'shell-focusable h-8 shrink-0 rounded-lg bg-cafe-accent px-3 text-compact font-medium text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:cursor-not-allowed';
export const capsuleSecondary =
  'shell-focusable h-8 shrink-0 rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] px-3 text-compact';

export function MemoryCapsuleEditor({
  value,
  change,
  original,
  revision,
  ready,
  action,
  cancel,
  reread,
  message,
  setMessage,
}: {
  value: string;
  change: (value: string) => void;
  original: string;
  revision?: string;
  ready: boolean;
  action: MemoryOwnerActionState;
  cancel: () => void;
  reread: () => void;
  message: string;
  setMessage: (value: string) => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
    field.current?.scrollIntoView?.({ block: 'center' });
  }, []);
  const count = userCapsuleCharacterCount(value);
  const invalid = count === 0 || count > USER_CAPSULE_CHAR_LIMIT;
  const dirty = value !== splitUserCapsule(original).body;
  const state = action.busy
    ? '正在保存…'
    : action.error
      ? `修改还在。${action.error}`
      : message || (dirty ? '有修改还没保存 · 保存后从下一场新对话开始生效' : '没有改动');
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (action.retryable) {
          action.retry();
          return;
        }
        if (!ready || !revision || invalid || action.blocked) return;
        if (!dirty) {
          setMessage('没有要保存的修改');
          return;
        }
        action.submit({
          action: 'replace_content',
          expectedRevision: revision,
          content: splitUserCapsule(original).prefix + value,
        });
      }}
    >
      <label className="block text-sm">
        <span className="sr-only">关于你内容</span>
        <textarea
          ref={field}
          aria-label="关于你内容"
          aria-describedby="capsule-count"
          aria-invalid={count > USER_CAPSULE_CHAR_LIMIT}
          value={value}
          onChange={(event) => {
            change(event.target.value);
            setMessage('');
          }}
          disabled={action.busy || action.retryable}
          maxLength={20_000}
          placeholder="比如：怎么称呼你、你在做什么、希望猫怎么和你说话。"
          className={`min-h-64 w-full resize-y rounded-lg border bg-[var(--console-card-bg)] p-3 text-sm leading-relaxed outline-none focus:border-cafe-accent focus:ring-1 focus:ring-[var(--cafe-accent)] ${count > USER_CAPSULE_CHAR_LIMIT ? 'border-[var(--semantic-critical)]' : 'border-cafe-subtle'}`}
        />
      </label>
      <div id="capsule-count" className="flex flex-wrap items-start justify-between gap-2 text-xs text-cafe-muted">
        <span>猫在新对话开场时会读到这段</span>
        <span>
          {count > 270 && (
            <span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--semantic-warning)]" />
          )}
          {count} / 300 字 · 空白不计{count > 270 && count <= 300 ? ' · 接近上限' : ''}
        </span>
      </div>
      {count > 300 && (
        <p role="alert" className="text-xs">
          超出 {count - 300} 字，删掉一些才能保存。
        </p>
      )}
      <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center justify-between gap-3 rounded-b-xl border border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] px-4 py-3 md:-mx-6 md:-mb-6 md:px-6">
        <p role={action.error ? 'alert' : 'status'} className="min-w-0 flex-1 text-compact">
          {state}
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={action.busy} className={capsuleSecondary} onClick={cancel}>
            放弃修改
          </button>
          {action.error && !action.retryable ? (
            <button type="button" className={capsulePrimary} onClick={reread}>
              重读当前版本
            </button>
          ) : (
            <button
              type="submit"
              className={capsulePrimary}
              disabled={action.busy || (!action.retryable && (!ready || invalid))}
            >
              {action.retryable ? '重新保存' : '保存'}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
