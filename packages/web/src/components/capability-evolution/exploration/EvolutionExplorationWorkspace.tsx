'use client';
import { refIdentity } from '@cat-cafe/shared';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { ExplorationActions } from './ExplorationActions';
import { ExplorationCaseList } from './ExplorationCaseList';
import { ExplorationComparison } from './ExplorationComparison';
import { ExplorationConditions } from './ExplorationConditions';
import { ExplorationDecisionHeader } from './ExplorationDecisionHeader';
import { ExplorationDetailStatus } from './ExplorationDetailStatus';
import { ExplorationIcon } from './ExplorationIcon';
import { ExplorationNavigation } from './ExplorationNavigation';
import { ExplorationOutcome } from './ExplorationOutcome';
import { ExplorationPairedResults } from './ExplorationPairedResults';
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
    comparison,
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
      <ExplorationSourceStatus blockers={catalog.blockers} retry={resource.retry} />

      <div className="exploration-decision-layout">
        <ExplorationNavigation workspace={workspace} />
        <div className="exploration-decision-main">
          <ExplorationDecisionHeader workspace={workspace} />
          <div className="exploration-reading-tabs" role="group" aria-label="阅读内容">
            {(['results', 'changes', 'conditions'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                aria-pressed={(reading.inspector ?? 'results') === tab}
                onClick={() => change({ inspector: tab })}
              >
                {{ results: '结果与案例', changes: '改动与依据', conditions: '评估与观测' }[tab]}
              </button>
            ))}
          </div>
          {reading.inspector === 'changes' ? (
            <section className="exploration-inline-inspector" aria-label="改动与依据">
              <details className="exploration-adoption">
                <summary>当前沿用与记录来源</summary>
                <div className="exploration-current" role="status" aria-label="当前沿用">
                  当前沿用：
                  {asset.catalog
                    ? asset.catalog.currentVersionRefs
                        .map(
                          (ref) =>
                            asset.catalog?.versions.find(
                              (version) => refIdentity(version.versionRef) === refIdentity(ref),
                            )?.title ?? ref.assetId,
                        )
                        .join('、') || '来源尚无沿用记录'
                    : '尚待资产来源确认'}
                </div>
                <p>
                  {node.kind === 'public_archive'
                    ? '公开归档；采用以正式回执为准。'
                    : '来源发布的真实资产版本。阅读不会改变采用。'}
                </p>
              </details>
              <h3>这一版改了什么</h3>
              {node.changes.map((item, index) => (
                <div key={`${item.label}:${index}`}>
                  <h4>{item.label}</h4>
                  <p>{item.detail}</p>
                  <EvolutionSource label="依据" source={item.sourceRef} />
                </div>
              ))}
            </section>
          ) : reading.inspector === 'conditions' ? (
            <section className="exploration-inline-inspector" aria-label="评估与观测">
              {experiment ? (
                <ExplorationConditions experiment={experiment} onPreparation={onPreparation} />
              ) : (
                <p>尚无实验条件。</p>
              )}
              {compareExperiment && (
                <details>
                  <summary>对照实验的条件与来源</summary>
                  <ExplorationConditions experiment={compareExperiment} />
                </details>
              )}
            </section>
          ) : (
            <>
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
              {experiment?.status === 'failed' && (
                <p className="exploration-notice" role="status">
                  本轮未完成有效测量。{experiment.conditions.limitation}
                </p>
              )}
              {experiment && experiment.conditions.threshold.status === 'unknown' && (
                <p className="exploration-notice">效用门槛未冻结；已有记录不能作为通过结论。</p>
              )}
              {experiment &&
                detail?.status === 'resolved' &&
                compareExperiment &&
                compareDetail?.status === 'resolved' &&
                (comparison?.status === 'paired' ? (
                  <ExplorationPairedResults
                    programId={id}
                    left={{ experiment: compareExperiment, records: compareDetail.records }}
                    right={{ experiment, records }}
                    result={comparison}
                    reading={reading}
                    onChange={change}
                    onRetry={resource.retry}
                  />
                ) : (
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
                ))}
              <ExplorationDetailStatus detail={compareDetail} label="对照" retry={resource.retry} />
              {detail?.status === 'resolved' && comparison?.status !== 'paired' && (
                <ExplorationCaseList
                  records={records}
                  selectedCaseId={record?.caseId}
                  onSelect={(selectedCaseId) => change({ selectedCaseId })}
                />
              )}
              {record && experiment && comparison?.status !== 'paired' && (
                <section className="exploration-result" aria-label="所选案例结果">
                  <h3>
                    {record.label}
                    <span data-result={record.result.status}>{record.result.label}</span>
                  </h3>
                  <ExplorationOutcome
                    key={refIdentity(record.recordRef)}
                    programId={id}
                    record={record}
                    experiment={experiment}
                    label="本次"
                    retry={resource.retry}
                  />
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
            </>
          )}
          <details className="exploration-next-step" open={Boolean(reading.draft.text)}>
            <summary>继续探索 · 提出改法或补测</summary>
            <ExplorationActions
              projection={projection}
              node={node}
              experiment={experiment}
              reading={reading}
              onDraft={(draft) => change({ draft })}
            />
          </details>
        </div>
      </div>
    </section>
  );
}
