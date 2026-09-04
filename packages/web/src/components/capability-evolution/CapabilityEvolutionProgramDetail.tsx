import {
  type EvolutionProgramPresentationProjection,
  humanizeEvolutionTarget,
  lifecycleLabel,
  stageLabel,
} from './capability-evolution-presentation';

function userSummary(projection: EvolutionProgramPresentationProjection): {
  systemStatus: string;
  userAction: string;
} {
  switch (projection.program.lifecycle) {
    case 'paused':
      return {
        systemStatus: '进化已暂停，正在等待恢复',
        userAction: '需要你恢复后，系统才会继续推进',
      };
    case 'needs_expert':
      return {
        systemStatus: '系统正在等待补齐所需专家',
        userAction: '需要你选择或绑定合适的专家',
      };
    case 'terminal':
      return {
        systemStatus: '这一轮进化已结束，历史记录已保留',
        userAction: '无需继续推进；需要时可以查看记录',
      };
    case 'active':
      return {
        systemStatus: `正在推进“${stageLabel(projection.program.stage)}”`,
        userAction:
          projection.program.stage === 'awaiting_approval'
            ? '需要你查看并作出决定'
            : '你现在无需填写表格或处理内部依赖',
      };
  }
}

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
  const summary = userSummary(projection);
  return (
    <section
      className="rounded-2xl border border-cafe-subtle bg-cafe-surface p-4 shadow-sm"
      data-testid="capability-evolution-program-detail"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-micro font-bold uppercase tracking-[0.12em] text-cafe-accent">能力进化目标</p>
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

      <div
        className="mt-4 grid gap-3 rounded-xl bg-cafe-surface-sunken p-3 sm:grid-cols-3"
        data-testid="capability-evolution-user-summary"
      >
        <div>
          <p className="text-micro font-semibold text-cafe-muted">系统正在做什么</p>
          <p className="mt-1 text-xs font-semibold text-cafe-black">{summary.systemStatus}</p>
        </div>
        <div>
          <p className="text-micro font-semibold text-cafe-muted">你现在是否需要行动</p>
          <p className="mt-1 text-xs font-semibold text-cafe-black">{summary.userAction}</p>
        </div>
        <div>
          <p className="text-micro font-semibold text-cafe-muted">下一步</p>
          <p className="mt-1 text-xs font-semibold text-cafe-black">{projection.nextAction.label}</p>
        </div>
        {projection.blockers.length > 0 && (
          <p className="text-xs leading-5 text-cafe-secondary sm:col-span-3">
            系统正在补齐 {projection.blockers.length} 项所需信息；只有需要你判断时才会单独提醒。
          </p>
        )}
      </div>

      <section className="mt-4 border-t border-cafe-subtle pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-cafe-black">进展记录</h3>
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
            </article>
          ))}
        </div>
      </section>

      <details
        className="mt-4 border-t border-cafe-subtle pt-4 text-xs text-cafe-secondary"
        data-testid="capability-evolution-technical-details"
      >
        <summary className="cursor-pointer font-semibold text-cafe-secondary">技术详情</summary>
        <div className="mt-3 space-y-3 rounded-xl bg-cafe-surface-sunken p-3">
          <div>
            <p className="font-semibold text-cafe-black">内部状态</p>
            <p className="mt-1 break-all font-mono text-micro text-cafe-muted">
              Program sequence {projection.program.sequence} · {projection.program.programId}
            </p>
          </div>
          <div>
            <p className="font-semibold text-cafe-black">归属与证书</p>
            <p className="mt-1 break-all font-mono text-micro text-cafe-muted">
              {projection.program.objectRef.ownerFeatureId} · {projection.program.objectRef.ownerStateRef}
            </p>
            <p className="mt-1 break-all font-mono text-micro text-cafe-muted">
              {projection.program.claimRef.ownerFeatureId} · {projection.program.claimRef.ownerStateRef}
            </p>
            <p className="mt-1 break-all font-mono text-micro text-cafe-muted">
              certificates: {JSON.stringify(projection.program.certificates)}
            </p>
          </div>
          {projection.blockers.length > 0 && (
            <div>
              <p className="font-semibold text-cafe-black">内部依赖</p>
              <ul className="mt-1 space-y-1">
                {projection.blockers.map((blocker) => (
                  <li key={blocker.code}>
                    <span className="font-mono text-micro text-cafe-muted">{blocker.code}</span> · {blocker.message} ·{' '}
                    {blocker.ownerFeatureId}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="font-semibold text-cafe-black">谱系引用</p>
            <ul className="mt-1 space-y-1">
              {projection.cycles.flatMap((cycle) =>
                cycle.lineageRefIds.map((ref) => (
                  <li key={`${cycle.cycle}:${ref}`} className="break-all font-mono text-micro text-cafe-muted">
                    {ref}
                  </li>
                )),
              )}
            </ul>
          </div>
        </div>
      </details>
    </section>
  );
}
