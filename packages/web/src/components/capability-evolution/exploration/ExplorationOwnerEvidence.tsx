import { type ExactAssetVersionRefV1, refIdentity } from '@cat-cafe/shared';
import { EvolutionActualUse, EvolutionSource, EvolutionVersionEvidence } from '../EvolutionVersionEvidence';
import type { useEvolutionAssetReview } from '../evolution-asset-resource';
import { currentVersionDiff } from '../evolution-version-view';

export function ExplorationOwnerEvidence({
  versionRef,
  asset,
  onSelect,
}: {
  versionRef?: ExactAssetVersionRefV1;
  asset: ReturnType<typeof useEvolutionAssetReview>;
  onSelect(ref: ExactAssetVersionRefV1): void;
}) {
  const selected =
    asset.review?.status === 'resolved' &&
    asset.review.selected &&
    (!versionRef || refIdentity(asset.review.selected.versionRef) === refIdentity(versionRef))
      ? asset.review.selected
      : undefined;
  const readStatus =
    asset.error || asset.review?.blockers.length
      ? 'unavailable'
      : asset.loading
        ? 'loading'
        : asset.catalog
          ? 'resolved'
          : 'unavailable';
  const diff = currentVersionDiff(selected, asset.catalog?.status === 'resolved' ? asset.catalog : undefined);
  return (
    <>
      <details className="exploration-owner-diff">
        <summary>本项目正式版本的内容变化</summary>
        <label className="exploration-owner-selector">
          本项目正式版本
          <select
            aria-label="本项目正式版本"
            value={versionRef ? refIdentity(versionRef) : ''}
            onChange={(event) => {
              const next = asset.catalog?.versions.find(
                (entry) => refIdentity(entry.versionRef) === event.target.value,
              );
              if (next) onSelect(next.versionRef);
            }}
          >
            <option value="" disabled>
              选择来源已发布的版本
            </option>
            {asset.catalog?.versions.map((entry) => (
              <option key={refIdentity(entry.versionRef)} value={refIdentity(entry.versionRef)}>
                {entry.title ?? entry.versionRef.version}
              </option>
            ))}
          </select>
        </label>
        {diff ? (
          <>
            <p>相对当前采用 {diff.comparedToVersionRef.version}</p>
            <p className="whitespace-pre-line">{diff.summary}</p>
            <EvolutionSource label="展开原始 diff" source={diff.rawDiffRef} href={diff.ownerHref} />
          </>
        ) : (
          <p>与最新采用版的内容对照尚待来源确认。</p>
        )}
        <p className="exploration-caption">内容变化解释机制，行为改善仍要看绑定此版本的实际记录。</p>
      </details>
      <details className="exploration-owner-evidence">
        <summary>本项目正式版本的独立验证与后续沿用</summary>
        <EvolutionVersionEvidence selected={selected} readStatus={readStatus} />
        <EvolutionActualUse selected={selected} readStatus={readStatus} />
      </details>
    </>
  );
}
