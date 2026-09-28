import { type EvolutionResolvedAssetReviewV1, type ExactAssetVersionRefV1, refIdentity } from '@cat-cafe/shared';
import { EvolutionSource } from './EvolutionVersionEvidence';
import type { EvolutionProgramProjection } from './evolution-program-projection';
import { type EvolutionReadStatus, pendingOwnerRead } from './evolution-read-status';
import { currentVersionDiff, type EvolutionVersionView, hasAssetBranch } from './evolution-version-view';

const DECISIONS = {
  keep: '保留这次改进',
  tune: '继续调整',
  rollback: '已回退',
  sunset: '已停止',
  no_change: '保持现状',
};

function versionSummary(version: EvolutionVersionView, diff: ReturnType<typeof currentVersionDiff>): string {
  if (diff?.status === 'available') return diff.summary;
  return version.parents.length
    ? `由 ${version.parents.map((parent) => parent.version).join('、')} 派生`
    : 'owner 未声明这个条目的派生关系。';
}

export function EvolutionVersionHistory({
  projection,
  versions,
  selectedKey,
  onSelect,
  review,
  selectedReview,
  readStatus = 'unavailable',
  onOpenPreparation,
}: {
  projection: EvolutionProgramProjection;
  versions: EvolutionVersionView[];
  selectedKey?: string;
  onSelect: (version: ExactAssetVersionRefV1) => void;
  review?: EvolutionResolvedAssetReviewV1;
  selectedReview?: EvolutionResolvedAssetReviewV1['selected'];
  readStatus?: EvolutionReadStatus;
  onOpenPreparation?: () => void;
}) {
  const changes = projection.lineage?.cycles.flatMap((cycle) => cycle.changes) ?? [];
  return (
    <section aria-label="更改历史" className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-cafe">留下了哪些改变</h2>
        <p className="evolution-empty mt-2">选一个版本，查看它的变化、证据和后续使用。</p>
      </div>
      {onOpenPreparation && (
        <div className="evolution-preparation-entry">
          <p className="evolution-empty">公开实验与回放保留在准备材料中，不会冒充正式版本历史。</p>
          <button type="button" className="evolution-link mt-2" onClick={onOpenPreparation}>
            查看已发布的公开实验与回放
          </button>
        </div>
      )}
      {versions.length === 0 ? (
        <p className="evolution-empty py-6">
          {review
            ? '还没有资产版本记录。评估准备与缺证记录保留在本轮判断中。'
            : pendingOwnerRead(readStatus, '资产版本记录')}
        </p>
      ) : (
        <ol className="evolution-version-log" aria-label="资产版本记录">
          {versions.map((version) => {
            const key = refIdentity(version.ref);
            const owner = review?.versions.find((item) => refIdentity(item.versionRef) === key);
            const diff =
              selectedReview && refIdentity(selectedReview.versionRef) === key
                ? currentVersionDiff(selectedReview, review)
                : undefined;
            return (
              <li key={key} data-selected={selectedKey === key}>
                <button
                  type="button"
                  className="w-full text-left"
                  aria-pressed={selectedKey === key}
                  onClick={() => onSelect(version.ref)}
                >
                  <span className="text-sm font-semibold text-cafe">{owner?.title ?? version.ref.version}</span>
                  {version.current && <span className="evolution-version-badge ml-3">当前采用</span>}
                  {owner?.title && (
                    <span className="mt-1 block break-all font-mono text-xs text-cafe-muted">
                      {version.ref.version}
                    </span>
                  )}
                  <span className="mt-1 block break-words text-xs text-cafe-muted">{version.ref.assetId}</span>
                </button>
                {diff && (
                  <p className="mt-3 text-xs text-cafe-muted">相对当前采用 {diff.comparedToVersionRef.version}</p>
                )}
                <p className="mt-2 text-sm leading-6 text-cafe-secondary">{versionSummary(version, diff)}</p>
                {diff?.status === 'available' && (
                  <EvolutionSource label="展开原始 diff" source={diff.rawDiffRef} href={diff.ownerHref} />
                )}
                <EvolutionSource label="版本来源" source={version.ref} />
              </li>
            );
          })}
        </ol>
      )}
      {hasAssetBranch(versions) && (
        <details>
          <summary className="evolution-link cursor-pointer">查看版本分支</summary>
          <section className="evolution-branch mt-3" aria-label="资产来源确认的分支">
            {versions
              .filter((version) => version.parents.length)
              .map((version) => (
                <div className="evolution-branch-row" key={refIdentity(version.ref)}>
                  <span>{version.parents.map((parent) => parent.version).join(' + ')}</span>
                  <span aria-hidden="true">↳</span>
                  <button type="button" className="evolution-link" onClick={() => onSelect(version.ref)}>
                    {version.ref.version}
                  </button>
                  {version.current && <span className="evolution-version-badge">当前采用</span>}
                </div>
              ))}
          </section>
        </details>
      )}
      {changes.length === 0 && versions.length > 0 && <p className="evolution-empty">本项目尚无改动执行记录。</p>}
      {!!projection.lineage?.cycles.some((cycle) => cycle.decision) && (
        <details>
          <summary className="cursor-pointer text-xs text-cafe-secondary">各轮处理结果</summary>
          <ol className="mt-3 space-y-3">
            {projection.lineage.cycles
              .filter((cycle) => cycle.decision)
              .map((cycle) => (
                <li key={cycle.cycle} className="text-sm text-cafe-secondary">
                  第 {cycle.cycle} 轮 · {cycle.decision && DECISIONS[cycle.decision]}
                  {cycle.decisionRef && <EvolutionSource label="决定来源" source={cycle.decisionRef} />}
                  {cycle.executionReceiptRef && <EvolutionSource label="执行回执" source={cycle.executionReceiptRef} />}
                </li>
              ))}
          </ol>
        </details>
      )}
    </section>
  );
}
