import {
  blockerLabel,
  blockerOwnerLabel,
  type EvolutionProgramPresentationProjection,
  humanizeEvolutionTarget,
  productStatus,
  stageLabel,
} from './capability-evolution-presentation';

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function SetupFace({ projection }: { projection: EvolutionProgramPresentationProjection }) {
  return (
    <section
      className="mt-4 rounded-xl border border-cafe-subtle/75 bg-cafe-surface-sunken p-4"
      data-testid="capability-evolution-setup"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-cafe-black">评估配置</h3>
        <span className="text-xs font-semibold text-cafe-secondary">{projection.blockers.length} 项待完成</span>
      </div>
      <p className="mt-1 text-xs leading-5 text-cafe-secondary">
        先建立可靠的评估条件，完成后才会开始观测这项能力的变化。
      </p>
      {projection.blockers.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {projection.blockers.map((blocker) => (
            <li
              key={`${blocker.code}:${blocker.ownerStateRef ?? blocker.ownerFeatureId}`}
              className="flex items-center justify-between gap-3 rounded-lg bg-cafe-surface px-3 py-2.5"
            >
              <span className="text-xs font-semibold text-cafe-black">{blockerLabel(blocker.code)}</span>
              <span className="shrink-0 text-micro text-cafe-muted">{blockerOwnerLabel(blocker.ownerFeatureId)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 rounded-lg bg-cafe-surface px-3 py-2.5 text-xs text-cafe-secondary">
          已登记评估条件，正在确认信号可用。
        </p>
      )}
    </section>
  );
}

function JourneyFace({ projection }: { projection: EvolutionProgramPresentationProjection }) {
  const status = productStatus(projection);
  return (
    <section
      className="mt-4 rounded-xl border border-cafe-subtle/75 bg-cafe-surface-sunken p-4"
      data-testid="capability-evolution-conclusion"
    >
      <p className="text-micro font-semibold text-cafe-muted">当前结论</p>
      <h3 className="mt-1 text-sm font-semibold text-cafe-black">{status.description}</h3>
      {projection.program.lifecycle === 'active' && projection.program.stage === 'observing' && (
        <p className="mt-2 text-xs leading-5 text-cafe-secondary">证据还在积累，本轮暂不作采纳或回滚判断。</p>
      )}
    </section>
  );
}

function LifecycleStatusFace({ projection }: { projection: EvolutionProgramPresentationProjection }) {
  const status = productStatus(projection);
  return (
    <section
      className="mt-4 rounded-xl border border-cafe-subtle/75 bg-cafe-surface-sunken p-4"
      data-testid="capability-evolution-lifecycle-status"
    >
      <p className="text-micro font-semibold text-cafe-muted">当前状态</p>
      <h3 className="mt-1 text-sm font-semibold text-cafe-black">{status.description}</h3>
      <p className="mt-2 text-xs leading-5 text-cafe-secondary">
        {projection.program.lifecycle === 'paused'
          ? '暂停期间不会继续观测或评估；恢复后从保留的进度继续。'
          : '只挂起这一项能力；现有配置、证据与历史保持不变。'}
      </p>
    </section>
  );
}

function EvidenceAndProcess({ projection }: { projection: EvolutionProgramPresentationProjection }) {
  return (
    <details className="mt-4 border-t border-cafe-subtle pt-4 text-xs text-cafe-secondary">
      <summary className="cursor-pointer font-semibold text-cafe-secondary">证据与过程</summary>
      <div className="mt-3 space-y-2">
        {projection.cycles.map((cycle) => (
          <article key={cycle.cycle} className="rounded-xl bg-cafe-surface-sunken p-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-semibold text-cafe-black">
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
    </details>
  );
}

function RawDetails({ projection }: { projection: EvolutionProgramPresentationProjection }) {
  return (
    <details
      className="mt-4 border-t border-cafe-subtle pt-4 text-xs text-cafe-secondary"
      data-testid="capability-evolution-technical-details"
    >
      <summary className="cursor-pointer font-semibold text-cafe-secondary">原始记录</summary>
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
  );
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
  const status = productStatus(projection);
  return (
    <section
      className="rounded-2xl border border-cafe-subtle bg-cafe-surface p-4 shadow-sm"
      data-testid="capability-evolution-program-detail"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-cafe-black">{target.title}</h2>
          <p className="mt-1 text-xs text-cafe-secondary">
            {status.label} · 第 {projection.program.cycle} 轮
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onOpenProgram(projection.program.programId)}
            className="rounded-lg px-2 py-1 text-xs font-semibold text-cafe-secondary hover:bg-cafe-hover"
          >
            管理
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs text-cafe-muted hover:bg-cafe-hover"
          >
            收起
          </button>
        </div>
      </div>

      {status.face === 'setup' ? (
        <SetupFace projection={projection} />
      ) : status.face === 'lifecycle' ? (
        <LifecycleStatusFace projection={projection} />
      ) : (
        <JourneyFace projection={projection} />
      )}
      <EvidenceAndProcess projection={projection} />
      <RawDetails projection={projection} />
    </section>
  );
}
