'use client';
import { type FormEvent, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';

export function StartEvolution({ targetThreadId }: { targetThreadId: string | null }) {
  const setPendingChatInsert = useChatStore((state) => state.setPendingChatInsert);
  const targetThreadTitle = useChatStore((state) => {
    if (!targetThreadId) return null;
    const thread = state.threads.find((candidate) => candidate.id === targetThreadId);
    return thread ? thread.title?.trim() || '未命名对话' : null;
  });
  const [target, setTarget] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = target.trim();
    if (!normalized) return;
    if (!targetThreadId || !targetThreadTitle) {
      setNotice('当前工作区没有可写入的目标对话。');
      return;
    }
    setPendingChatInsert({ threadId: targetThreadId, text: `我们来进化 ${normalized}` });
    setTarget('');
    setNotice(`已带到「${targetThreadTitle}」，原有草稿已保留。由你确认后发送。`);
  };

  return (
    <section className="rounded-2xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-4 shadow-sm">
      <form className="flex flex-col gap-2" onSubmit={submit}>
        <label className="sr-only" htmlFor="capability-evolution-target">
          想持续改进哪项能力
        </label>
        <input
          id="capability-evolution-target"
          data-testid="capability-evolution-start-input"
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
            setNotice(null);
          }}
          placeholder="例如：让代码审阅更少返工"
          className="min-w-0 flex-1 rounded-xl border border-cafe-subtle bg-cafe-surface px-3.5 py-2.5 text-sm text-cafe-black outline-none transition-colors placeholder:text-cafe-muted focus:border-cafe-accent"
        />
        <button
          type="submit"
          data-testid="capability-evolution-start"
          disabled={!target.trim() || !targetThreadTitle}
          className="evolution-primary"
        >
          带到这个对话
        </button>
      </form>
      <div className="mt-2 flex items-start justify-between gap-3 text-xs text-cafe-muted">
        <div data-testid="capability-evolution-chat-destination">
          {targetThreadTitle ? (
            <p>当前对话：{targetThreadTitle}</p>
          ) : (
            <>
              <p className="font-semibold text-cafe-secondary">没有可写入的目标对话</p>
              <p className="mt-1 leading-5">请先回到一个对话，再从该对话的工作区打开能力进化。</p>
            </>
          )}
        </div>
      </div>
      {notice && (
        <output className="mt-2 text-xs text-cafe-secondary" aria-live="polite">
          {notice}
        </output>
      )}
    </section>
  );
}
