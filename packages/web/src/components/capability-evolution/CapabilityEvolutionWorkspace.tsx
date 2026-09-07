'use client';

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { CapabilityEvolutionProgramDetail } from './CapabilityEvolutionProgramDetail';
import { CapabilityEvolutionProgramRow } from './CapabilityEvolutionProgramRow';
import {
  type EvolutionProgramPresentationProjection,
  parseEvolutionProgramProjection,
} from './capability-evolution-presentation';

function StartEvolution({ targetThreadId }: { targetThreadId: string | null }) {
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
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submit}>
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
          placeholder="例如：投资人路演效果"
          className="min-w-0 flex-1 rounded-xl border border-cafe-subtle bg-cafe-surface px-3.5 py-2.5 text-sm text-cafe-black outline-none transition-colors placeholder:text-cafe-muted focus:border-cafe-accent"
        />
        <button
          type="submit"
          data-testid="capability-evolution-start"
          disabled={!target.trim() || !targetThreadTitle}
          className="rounded-xl bg-cafe-accent px-4 py-2.5 text-sm font-semibold text-[var(--cafe-surface)] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
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

export function CapabilityEvolutionWorkspace({
  targetThreadId,
  onOpenProgram,
}: {
  targetThreadId: string | null;
  onOpenProgram: (programId: string) => void;
}) {
  const [programs, setPrograms] = useState<EvolutionProgramPresentationProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [selectedProgramId, setSelectedProgramId] = useState<string | null>(null);
  const [rejectedProgramCount, setRejectedProgramCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch('/api/capability-evolution/programs');
      if (!response.ok) throw new Error('Program owner unavailable');
      const body = (await response.json()) as { programs?: unknown };
      if (!Array.isArray(body.programs)) throw new Error('Program list invalid');
      const parsed = body.programs.flatMap((value) => {
        const projection = parseEvolutionProgramProjection(value);
        return projection ? [projection] : [];
      });
      setPrograms(parsed);
      setRejectedProgramCount(body.programs.length - parsed.length);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const loadWhenVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    void load();
    const poll = window.setInterval(loadWhenVisible, 2_000);
    window.addEventListener('focus', loadWhenVisible);
    document.addEventListener('visibilitychange', loadWhenVisible);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener('focus', loadWhenVisible);
      document.removeEventListener('visibilitychange', loadWhenVisible);
    };
  }, [load]);

  const selected = useMemo(
    () => programs.find((projection) => projection.program.programId === selectedProgramId) ?? null,
    [programs, selectedProgramId],
  );

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto bg-[var(--console-panel-bg)]"
      data-testid="capability-evolution-workspace"
    >
      <div className="mx-auto w-full max-w-5xl space-y-5 px-5 py-5">
        <header>
          <h1 className="text-xl font-semibold tracking-tight text-cafe-black">能力进化</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-cafe-secondary">持续观测、评估并采纳能力改进。</p>
        </header>

        <StartEvolution key={targetThreadId ?? 'unbound'} targetThreadId={targetThreadId} />

        <section aria-labelledby="capability-evolution-programs-heading">
          <div className="mb-2 flex items-end justify-between gap-3">
            <div>
              <h2 id="capability-evolution-programs-heading" className="text-sm font-semibold text-cafe-black">
                能力项目
              </h2>
              <p className="mt-1 text-xs text-cafe-muted">每一项能力独立观测、评估与保留改进。</p>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="text-xs font-semibold text-cafe-accent hover:underline"
            >
              刷新
            </button>
          </div>

          {loading ? (
            <div className="rounded-xl border border-cafe-subtle px-4 py-8 text-center text-xs text-cafe-muted">
              正在读取能力进化记录…
            </div>
          ) : unavailable && programs.length === 0 ? (
            <div className="rounded-xl border border-cafe-subtle px-4 py-8 text-center text-xs text-cafe-muted">
              暂时无法读取进化记录，请稍后刷新。系统不会用临时数据冒充真实进展。
            </div>
          ) : rejectedProgramCount > 0 && programs.length === 0 ? (
            <div className="rounded-xl border border-cafe-subtle px-4 py-8 text-center text-xs text-cafe-muted">
              {rejectedProgramCount} 项进化记录暂时无法读取；原始记录仍安全保留，请刷新或更新页面。
            </div>
          ) : programs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-cafe-subtle px-4 py-8 text-center">
              <p className="text-sm font-semibold text-cafe-black">还没有进化记录</p>
              <p className="mt-1 text-xs text-cafe-muted">在上方写下想改进什么，再由你从目标对话发送即可开始。</p>
            </div>
          ) : (
            <div className="space-y-3">
              {rejectedProgramCount > 0 && (
                <output
                  aria-live="polite"
                  className="block rounded-xl border border-cafe-subtle px-3 py-2 text-xs text-cafe-muted"
                >
                  {rejectedProgramCount} 项进化记录暂时无法读取；其余记录仍可使用。
                </output>
              )}
              <div className="space-y-2">
                {programs.map((projection) => (
                  <CapabilityEvolutionProgramRow
                    key={projection.program.programId}
                    projection={projection}
                    selected={selectedProgramId === projection.program.programId}
                    onSelect={() => setSelectedProgramId(projection.program.programId)}
                  />
                ))}
              </div>
            </div>
          )}
        </section>

        {selected && (
          <CapabilityEvolutionProgramDetail
            projection={selected}
            onClose={() => setSelectedProgramId(null)}
            onOpenProgram={onOpenProgram}
          />
        )}
      </div>
    </div>
  );
}
