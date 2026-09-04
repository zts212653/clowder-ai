'use client';

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { CapabilityEvolutionProgramDetail } from './CapabilityEvolutionProgramDetail';
import {
  type EvolutionProgramPresentationProjection,
  humanizeEvolutionTarget,
  lifecycleLabel,
  parseEvolutionProgramProjection,
  stageLabel,
} from './capability-evolution-presentation';

function EvolutionMark({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 2.5c7 3.5 7 11.5 0 15M14 2.5c-7 3.5-7 11.5 0 15M6.8 5.2h6.4M5.8 10h8.4M6.8 14.8h6.4" />
    </svg>
  );
}

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
    <section className="rounded-2xl border border-cafe-accent/20 bg-cafe-accent/5 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cafe-accent/10 text-cafe-accent">
          <EvolutionMark />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-cafe-black">发起新的进化</h2>
          <p className="mt-1 text-xs leading-5 text-cafe-secondary">
            只说想改进什么。系统会整理目标和下一步，只有需要你判断时才会明确提醒。
          </p>
        </div>
      </div>
      <div className="mt-4 rounded-xl border border-cafe-subtle/75 bg-cafe-surface p-3">
        <div data-testid="capability-evolution-chat-destination">
          {targetThreadTitle ? (
            <p className="text-sm font-semibold text-cafe-black">在「{targetThreadTitle}」继续</p>
          ) : (
            <>
              <p className="text-sm font-semibold text-cafe-black">没有可写入的目标对话</p>
              <p className="mt-1 text-xs leading-5 text-cafe-secondary">
                请先回到一个对话，再从该对话的工作区打开能力进化。
              </p>
            </>
          )}
        </div>
      </div>
      <form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={submit}>
        <label className="sr-only" htmlFor="capability-evolution-target">
          想进化什么
        </label>
        <input
          id="capability-evolution-target"
          data-testid="capability-evolution-start-input"
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
            setNotice(null);
          }}
          placeholder="例如：投资人路演表达能力"
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
      {notice && (
        <output className="mt-2 text-xs text-cafe-secondary" aria-live="polite">
          {notice}
        </output>
      )}
    </section>
  );
}

function ProgramCard({
  projection,
  selected,
  onSelect,
}: {
  projection: EvolutionProgramPresentationProjection;
  selected: boolean;
  onSelect: () => void;
}) {
  const target = humanizeEvolutionTarget(projection.program.objectRef);
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`capability-evolution-program-${projection.program.programId}`}
      aria-pressed={selected}
      className="group w-full rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-4 text-left transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-cafe-accent/35 hover:bg-cafe-surface aria-pressed:border-cafe-accent/45 aria-pressed:bg-cafe-accent/5"
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-micro font-bold uppercase tracking-[0.12em] text-cafe-accent">能力进化目标</span>
          <span className="mt-1 block text-sm font-semibold text-cafe-black">{target.title}</span>
        </span>
        <span className="shrink-0 rounded-full bg-cafe-surface-sunken px-2.5 py-1 text-micro font-semibold text-cafe-secondary">
          {lifecycleLabel(projection.program.lifecycle)}
        </span>
      </span>
      <span className="mt-3 grid gap-1 border-t border-cafe-subtle/70 pt-3">
        <span className="text-xs font-semibold text-cafe-secondary">{stageLabel(projection.program.stage)}</span>
        <span className="text-xs leading-5 text-cafe-muted">下一步：{projection.nextAction.label}</span>
      </span>
    </button>
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
        <header className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-cafe-accent/10 text-cafe-accent">
            <EvolutionMark className="h-6 w-6" />
          </span>
          <div>
            <p className="text-micro font-bold uppercase tracking-[0.16em] text-cafe-accent">持续成长</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-cafe-black">能力进化</h1>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-cafe-secondary">
              在这里发起、继续和回看一次能力进化。系统会保留过程，并在真正需要你判断时提醒你。
            </p>
          </div>
        </header>

        <StartEvolution key={targetThreadId ?? 'unbound'} targetThreadId={targetThreadId} />

        <section aria-labelledby="capability-evolution-programs-heading">
          <div className="mb-2 flex items-end justify-between gap-3">
            <div>
              <h2 id="capability-evolution-programs-heading" className="text-sm font-semibold text-cafe-black">
                正在进行与历史记录
              </h2>
              <p className="mt-1 text-xs text-cafe-muted">先看进展与下一步；技术信息需要时再展开。</p>
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
              <div className="grid gap-3 sm:grid-cols-2">
                {programs.map((projection) => (
                  <ProgramCard
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
