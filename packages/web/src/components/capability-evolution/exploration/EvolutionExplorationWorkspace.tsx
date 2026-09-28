'use client';
import { refIdentity } from '@cat-cafe/shared';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { ExplorationActions } from './ExplorationActions';
import { ExplorationBehavior } from './ExplorationBehavior';
import { ExplorationCaseList } from './ExplorationCaseList';
import { ExplorationComparison } from './ExplorationComparison';
import { ExplorationConditions } from './ExplorationConditions';
import { ExplorationDetailStatus } from './ExplorationDetailStatus';
import { ExplorationIcon } from './ExplorationIcon';
import { ExplorationMedia } from './ExplorationMedia';
import { ExplorationNavigation } from './ExplorationNavigation';
import { ExplorationSourceStatus } from './ExplorationSourceStatus';
import { ExplorationSummary } from './ExplorationSummary';
import { useExplorationWorkspace } from './use-exploration-workspace';

export function EvolutionExplorationWorkspace({
  projection,
  mode = 'workspace',
  onPreparation,
}: {
  projection: EvolutionProgramProjection;
  mode?: 'summary' | 'workspace';
  onPreparation?: () => void;
}) {
  const workspace = useExplorationWorkspace(projection);
  const {
    id,
    reading,
    asset,
    change,
    resource,
    catalog,
    exactSource,
    node,
    experiments,
    experiment,
    detail,
    records,
    record,
    compareExperiment,
    compareDetail,
    pairedMediaVisible,
    acceptComparisonScope,
    resetSelection,
  } = workspace;
  if (!catalog)
    return (
      <section className="exploration-workspace" aria-label="探索进化">
        <h2>
          <ExplorationIcon kind="branch" />
          探索进化
        </h2>
        <p role="status">{resource.error ?? '正在读取版本与实验…'}</p>
        <ExplorationSourceStatus blockers={resource.blockers} retry={resource.retry} />
        {resource.error && (
          <>
            <button type="button" className="exploration-link" onClick={resource.retry}>
              重新读取探索记录
            </button>
            <button type="button" className="exploration-link" onClick={resetSelection}>
              回到可用版本
            </button>
          </>
        )}
        {onPreparation && (
          <button type="button" className="exploration-link" onClick={onPreparation}>
            回读准备材料
          </button>
        )}
      </section>
    );
  if (!node)
    return (
      <section className="exploration-workspace">
        <h2>探索进化</h2>
        <ExplorationSourceStatus blockers={catalog.blockers} retry={resource.retry} />
        <p>
          {reading.selectedNodeRef || exactSource
            ? '这个版本暂时无法定位，原选择仍保留。'
            : '来源尚未发布可阅读的版本或归档。补测与未产出请求不会生成版本节点。'}
        </p>
        <button type="button" onClick={resource.retry}>
          重新读取
        </button>
        <button type="button" onClick={resetSelection}>
          回到可用版本
        </button>
      </section>
    );
  if (mode === 'summary')
    return (
      <>
        <ExplorationSourceStatus blockers={catalog.blockers} retry={resource.retry} />
        <ExplorationSummary
          node={node}
          experiments={experiments}
          experiment={experiment}
          records={records}
          detail={detail}
          compareDetail={compareDetail}
          retry={resource.retry}
          onPreparation={onPreparation}
        />
      </>
    );

  return (
    <section
      className="exploration-workspace"
      aria-label="探索进化工作面"
      data-testid="evolution-exploration-workspace"
    >
      <div className="exploration-heading">
        <h2>版本与实验</h2>
        <button
          type="button"
          className="exploration-primary"
          onClick={() => document.getElementById(`exploration-input-${id}`)?.focus()}
        >
          继续探索 <ExplorationIcon kind="work" />
        </button>
      </div>
      <p className="exploration-scope">
        {node.kind === 'public_archive'
          ? '公开归档 · 每个节点是一整套改动；采用以正式回执为准。'
          : '每个节点来自资产来源的真实版本；阅读与采用相互独立。'}
      </p>
      <ExplorationSourceStatus blockers={catalog.blockers} retry={resource.retry} />
      <div className="exploration-current" role="status" aria-label="当前沿用">
        当前沿用：
        {asset.catalog
          ? asset.catalog.currentVersionRefs
              .map(
                (ref) =>
                  asset.catalog?.versions.find((version) => refIdentity(version.versionRef) === refIdentity(ref))
                    ?.title ?? ref.assetId,
              )
              .join('、') || '来源尚无沿用记录'
          : '尚待资产来源确认'}
      </div>
      <ExplorationNavigation workspace={workspace} />
      {resource.loading && (
        <p role="status" className="exploration-caption">
          正在读取当前选择的记录…
        </p>
      )}
      {resource.error && (
        <p role="alert">
          {resource.error}
          <button type="button" onClick={resource.retry}>
            重试
          </button>
        </p>
      )}
      <ExplorationDetailStatus detail={detail} retry={resource.retry} />
      {experiment && <ExplorationConditions experiment={experiment} onPreparation={onPreparation} />}
      {experiment && detail?.status === 'resolved' && compareExperiment && compareDetail?.status === 'resolved' && (
        <ExplorationComparison
          programId={id}
          left={{ experiment: compareExperiment, records: compareDetail.records }}
          right={{ experiment, records }}
          scope={reading.comparisonScope}
          scopeKey={reading.comparisonScopeKey}
          selectedCaseId={record?.caseId}
          onScope={acceptComparisonScope}
          onSelectCase={(selectedCaseId) => change({ selectedCaseId })}
          onRetry={resource.retry}
        />
      )}
      <ExplorationDetailStatus detail={compareDetail} label="对照" retry={resource.retry} />
      {detail?.status === 'resolved' && (
        <ExplorationCaseList
          records={records}
          selectedCaseId={record?.caseId}
          onSelect={(selectedCaseId) => change({ selectedCaseId })}
        />
      )}
      {record && experiment && (
        <section className="exploration-result" aria-label="所选案例结果">
          <h3>
            {record.label}
            <span data-result={record.result.status}>{record.result.label}</span>
          </h3>
          {!pairedMediaVisible && (
            <ExplorationMedia
              key={refIdentity(record.recordRef)}
              programId={id}
              record={record}
              onRetry={resource.retry}
            />
          )}
          <ExplorationBehavior record={record} experiment={experiment} />
        </section>
      )}
      {!experiment && (
        <p className="exploration-notice">
          该版本尚无已发布的实验。内容变化可以解释机制，尚不能证明行为改善。
          {onPreparation && (
            <button type="button" onClick={onPreparation}>
              回读准备材料
            </button>
          )}
        </p>
      )}
      <ExplorationActions
        projection={projection}
        node={node}
        experiment={experiment}
        reading={reading}
        onDraft={(draft) => change({ draft })}
      />
    </section>
  );
}
