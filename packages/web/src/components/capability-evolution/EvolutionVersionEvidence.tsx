import { type EvolutionResolvedAssetReviewV1, type OwnerTruthRefV1, refIdentity } from '@cat-cafe/shared';
import { openInvocationTrajectory } from '@/components/workspace/trajectory/trajectory-navigation';
import { type EvolutionReadStatus, pendingOwnerRead } from './evolution-read-status';

interface VersionReadProps {
  selected?: EvolutionResolvedAssetReviewV1['selected'];
  readStatus?: EvolutionReadStatus;
}

export function EvolutionSource({ label, source, href }: { label: string; source: OwnerTruthRefV1; href?: string }) {
  return (
    <details className="evolution-source mt-3">
      <summary className="cursor-pointer">{label}</summary>
      <p className="mt-2 font-mono">
        {source.ownerFeatureId} · {source.ownerStateRef}
        {source.version ? ` · ${source.version}` : ''}
      </p>
      {href && (
        <a href={href} className="evolution-link mt-2 inline-block" target="_blank" rel="noreferrer">
          打开来源
        </a>
      )}
    </details>
  );
}

const ROLES = [
  ['comparison_baseline', '对照基线'],
  ['candidate_independent_verification', '候选独立验证'],
  ['post_adoption_observation', '采用后观察'],
] as const;

export function EvolutionVersionEvidence({
  selected,
  readStatus = selected ? 'resolved' : 'unavailable',
}: VersionReadProps) {
  return (
    <section aria-label="所选版本证据" className="space-y-5">
      <h3 className="text-sm font-semibold text-cafe">这个版本的证据</h3>
      {ROLES.map(([role, label]) => {
        const evidence = selected?.evidence.filter((item) => item.role === role) ?? [];
        return (
          <div key={role} className="border-b border-cafe-subtle pb-4 last:border-0">
            <h4 className="text-xs font-semibold text-cafe-secondary">{label}</h4>
            {evidence.length ? (
              evidence.map((item) => (
                <article key={refIdentity(item.evidenceRef)} className="mt-2">
                  <p className="text-sm leading-6 text-cafe">
                    {item.label ?? (item.status === 'verified' ? '来源已核验' : '证据仍不足')}
                  </p>
                  {item.label && (
                    <p className="mt-1 text-xs text-cafe-muted">
                      {item.status === 'verified' ? '来源已核验' : '证据仍不足'}
                    </p>
                  )}
                  <EvolutionSource label="证据与出处" source={item.evidenceRef} href={item.ownerHref} />
                  <EvolutionSource label="绑定证明" source={item.proofRef} />
                </article>
              ))
            ) : (
              <p className="evolution-empty mt-2">
                {selected && readStatus === 'resolved'
                  ? `尚未收到绑定此版本的${label}证据。`
                  : pendingOwnerRead(readStatus, `此版本的${label}证据`)}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function EvolutionActualUse({ selected, readStatus = selected ? 'resolved' : 'unavailable' }: VersionReadProps) {
  const uses = selected?.uses ?? [];
  return (
    <section aria-label="后续任务实际使用" className="border-t border-cafe-subtle pt-5">
      <h3 className="text-sm font-semibold text-cafe">后续沿用</h3>
      {uses.length ? (
        uses.map((use) => (
          <article key={refIdentity(use.receiptRef)} className="mt-3">
            <p className="text-sm text-cafe">
              {use.use === 'applied'
                ? '后续任务已实际使用这个版本'
                : use.use === 'dismissed'
                  ? '后续任务未采用这个版本'
                  : '后续任务的使用情况尚待确认'}
            </p>
            <p className="mt-1 text-xs text-cafe-muted">{new Date(use.occurredAt).toLocaleString('zh-CN')}</p>
            <EvolutionSource label="使用回执与任务来源" source={use.receiptRef} href={use.ownerHref} />
            <EvolutionSource label="运行来源" source={use.invocationRef} />
            <EvolutionSource label="实际使用方" source={use.consumerRef} />
            {use.taskRef && <EvolutionSource label="任务来源" source={use.taskRef} />}
            <button
              type="button"
              className="evolution-link mt-3"
              onClick={() =>
                openInvocationTrajectory({ invocationId: use.invocationRef.ownerStateRef.slice('inv:'.length) })
              }
            >
              打开后续任务轨迹
            </button>
          </article>
        ))
      ) : (
        <p className="evolution-empty mt-2">
          {selected && readStatus === 'resolved'
            ? '还没有后续任务实际使用此版本的记录。'
            : pendingOwnerRead(readStatus, '后续任务是否实际使用此版本')}
        </p>
      )}
    </section>
  );
}
