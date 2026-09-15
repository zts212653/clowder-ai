import {
  blockerLabel,
  blockerOwnerLabel,
  type EvolutionProgramPresentationProjection,
  preparationGaps,
  productStatus,
} from './capability-evolution-presentation';
import { EvolutionAttributionPanel } from './EvolutionAttributionPanel';
import { EvolutionObservationPanel } from './EvolutionObservationPanel';

export function SetupFace({ projection }: { projection: EvolutionProgramPresentationProjection }) {
  const gaps = preparationGaps(projection);
  return (
    <section className="mt-4 border-t border-cafe-subtle pt-4" data-testid="capability-evolution-setup">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-cafe-black">
          {projection.program.stage === 'constituting' ? '先确定目标与评估方式' : '评估还需要什么'}
        </h3>
        <span className="text-xs font-semibold text-cafe-secondary">{gaps.length} 项待完成</span>
      </div>
      <p className="mt-1 text-xs leading-5 text-cafe-secondary">
        {projection.program.stage === 'constituting'
          ? '目标、评估方式和负责人确认后，再接入真实任务的证据。'
          : '目标已确定；下面的证据尚未齐备，目前不能判断改进是否有效。'}
      </p>
      {gaps.length > 0 ? (
        <ul className="mt-3 divide-y divide-cafe-subtle">
          {gaps.map((blocker) => (
            <li
              key={`${blocker.code}:${blocker.ownerStateRef ?? blocker.ownerFeatureId}`}
              className="flex items-center justify-between gap-3 py-2.5"
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

export function JourneyFace({ projection }: { projection: EvolutionProgramPresentationProjection }) {
  const status = productStatus(projection);
  return (
    <section className="mt-4 border-t border-cafe-subtle pt-4" data-testid="capability-evolution-conclusion">
      <p className="text-micro font-semibold text-cafe-muted">当前结论</p>
      <h3 className="mt-1 text-sm font-semibold text-cafe-black">{status.description}</h3>
      {projection.program.lifecycle === 'active' && projection.program.stage === 'observing' && (
        <p className="mt-2 text-xs leading-5 text-cafe-secondary">证据还在积累，本轮暂不作采纳或回滚判断。</p>
      )}
    </section>
  );
}

export function LifecycleStatusFace({ projection }: { projection: EvolutionProgramPresentationProjection }) {
  const status = productStatus(projection);
  return (
    <section className="mt-4 border-t border-cafe-subtle pt-4" data-testid="capability-evolution-lifecycle-status">
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

export function RawDetails({ projection }: { projection: EvolutionProgramPresentationProjection }) {
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
          <p className="mt-1 text-micro text-cafe-muted">
            {projection.program.lifecycle} · {projection.program.stage}
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
        {projection.observation && <EvolutionObservationPanel observation={projection.observation} />}
        <EvolutionAttributionPanel explanation={projection.attribution ?? null} />
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
