import {
  type EvolutionProgramPresentationProjection,
  humanizeEvolutionTarget,
  lifecycleLabel,
  stageLabel,
} from './capability-evolution-presentation';

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function CapabilityEvolutionProgramDetail({
  projection,
  onClose,
  onOpenProgram,
}: {
  projection: EvolutionProgramPresentationProjection;
  onClose: () => void;
  onOpenProgram: (programId: string) => void;
}) {
  const target = humanizeEvolutionTarget(projection.program.objectRef);
  return (
    <section
      className="rounded-2xl border border-cafe-subtle bg-cafe-surface p-4 shadow-sm"
      data-testid="capability-evolution-program-detail"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-micro font-bold uppercase tracking-[0.12em] text-cafe-accent">{target.eyebrow}</p>
          <h2 className="mt-1 text-base font-semibold text-cafe-black">{target.title}</h2>
          <p className="mt-1 text-xs text-cafe-secondary">
            {lifecycleLabel(projection.program.lifecycle)} · {stageLabel(projection.program.stage)} · 第
            {projection.program.cycle} 轮
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onOpenProgram(projection.program.programId)}
            className="rounded-lg px-2 py-1 text-xs font-semibold text-cafe-accent hover:bg-cafe-accent/5"
          >
            管理生命周期
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs text-cafe-muted hover:bg-cafe-hover"
          >
            收起详情
          </button>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-cafe-surface-sunken p-3">
        <p className="text-micro font-semibold text-cafe-muted">现在的下一步</p>
        <p className="mt-1 text-sm font-semibold text-cafe-black">{projection.nextAction.label}</p>
      </div>

      <section className="mt-4">
        <h3 className="text-sm font-semibold text-cafe-black">待处理阻塞</h3>
        {projection.blockers.length === 0 ? (
          <p className="mt-2 text-xs text-cafe-secondary">当前没有阻塞，Program 可以继续推进。</p>
        ) : (
          <div className="mt-2 space-y-2">
            {projection.blockers.map((blocker) => (
              <div key={blocker.code} className="rounded-xl border border-cafe-subtle/75 px-3 py-2.5">
                <p className="text-xs font-semibold text-cafe-black">{blocker.message}</p>
                <p className="mt-1 text-micro text-cafe-muted">{blocker.ownerFeatureId} 负责补齐</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-4 border-t border-cafe-subtle pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-cafe-black">历史与能力谱系</h3>
          <span className="text-micro text-cafe-muted">Program sequence {projection.program.sequence}</span>
        </div>
        <div className="mt-2 space-y-2">
          {projection.cycles.map((cycle) => (
            <article key={cycle.cycle} className="rounded-xl bg-cafe-surface-sunken p-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-xs font-semibold text-cafe-black">
                  第 {cycle.cycle} 轮 · {stageLabel(cycle.stage)}
                </p>
                <span className="text-micro text-cafe-muted">{cycle.closedAt ? '已结束' : '当前轮次'}</span>
              </div>
              <p className="mt-1 text-micro text-cafe-muted">
                开始于 {dateLabel(cycle.openedAt)}
                {cycle.closedAt ? ` · 结束于 ${dateLabel(cycle.closedAt)}` : ''}
              </p>
              <p className="mt-2 text-micro font-semibold text-cafe-secondary">
                {cycle.lineageRefIds.length} 条 lineage 引用
              </p>
              {cycle.lineageRefIds.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {cycle.lineageRefIds.map((ref) => (
                    <li key={ref} className="break-all font-mono text-micro text-cafe-muted">
                      {ref}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
