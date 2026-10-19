import { refIdentity } from '@cat-cafe/shared';
import { useEffect, useRef } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { projectAssetVersions } from '../evolution-version-view';
import { ExplorationActions } from './ExplorationActions';
import { ExplorationConditions } from './ExplorationConditions';
import { ExplorationHistoryCases } from './ExplorationHistoryCases';
import {
  ExplorationHistoryPublicationNotice,
  ExplorationHistoryPublicationRecords,
} from './ExplorationHistoryPublication';
import { ExplorationNavigation } from './ExplorationNavigation';
import { ExplorationSourceStatus } from './ExplorationSourceStatus';
import { isHistoricalStep } from './exploration-history';
import type { useExplorationWorkspace } from './use-exploration-workspace';

export function ExplorationHistory({
  workspace,
  projection,
  mode,
}: {
  workspace: ReturnType<typeof useExplorationWorkspace>;
  projection: EvolutionProgramProjection;
  mode: 'summary' | 'workspace';
}) {
  const { catalog, node, resource, asset, reading, change, selectNode, experiment } = workspace;
  const heading = useRef<HTMLElement>(null);
  // Owner-issued exact selections choose content; the logical step only preserves UI position across publications.
  const nodeKey = node?.nodeRef.ownerStateRef;
  const previousStep = useRef(nodeKey);
  useEffect(() => {
    if (previousStep.current !== nodeKey) heading.current?.scrollIntoView?.({ block: 'start' });
    previousStep.current = nodeKey;
  }, [nodeKey]);
  if (!catalog || !isHistoricalStep(node)) return null;
  const steps = catalog.nodes.filter(isHistoricalStep);
  const next = steps[steps.findIndex((entry) => refIdentity(entry.nodeRef) === refIdentity(node.nodeRef)) + 1];
  const versions = projectAssetVersions(projection, asset.catalog);
  const names = (kind: 'adopted' | 'sourceCurrent') =>
    versions
      .filter((version) => version[kind])
      .map(
        (version) =>
          asset.catalog?.versions.find((entry) => refIdentity(entry.versionRef) === refIdentity(version.ref))?.title ??
          version.ref.assetId,
      )
      .join('、');
  const caseCount = catalog.experiments.filter((run) =>
    steps.some((step) => refIdentity(step.nodeRef) === refIdentity(run.nodeRef)),
  ).length;
  return (
    <section
      className="exploration-workspace exploration-history"
      data-testid={mode === 'workspace' ? 'evolution-exploration-workspace' : undefined}
      data-exploration-presentation="v2"
      aria-label="错题谱系"
    >
      <header className="exploration-history-heading">
        <h2>错题谱系</h2>
        <p>
          {steps.length} 步 · {caseCount} 道错题 · 更新到 {node.history.updatedThrough}
        </p>
        <div className="exploration-history-overview">
          {catalog.overviewMarkdown ? (
            <MarkdownContent content={catalog.overviewMarkdown} disableCommandPrefix />
          ) : (
            <p>{catalog.overview ?? '一路走来踩过的坑、当时怎么改、后来怎样了。这是历史记录，不算成功率。'}</p>
          )}
        </div>
      </header>
      <ExplorationHistoryPublicationNotice workspace={workspace} />
      <ExplorationSourceStatus blockers={catalog.blockers} retry={resource.retry} />
      {mode === 'workspace' && <ExplorationNavigation workspace={workspace} v2 historical />}
      <article ref={heading} data-history-step className="exploration-history-step">
        <header>
          <time>{node.history.period}</time>
          <h3>{node.title}</h3>
          {!node.bodyMarkdown && <p>{node.summary}</p>}
        </header>
        {node.bodyMarkdown && (
          <MarkdownContent
            content={node.bodyMarkdown}
            className="exploration-history-authored-body"
            disableCommandPrefix
          />
        )}
        {mode === 'workspace' && (
          <>
            {node.parentEdges.map((edge) => {
              const parent = catalog.nodes.find(
                (entry) => refIdentity(entry.nodeRef) === refIdentity(edge.parentNodeRef),
              );
              return (
                <p className="exploration-history-parent" key={refIdentity(edge.parentNodeRef)}>
                  接着上一步：
                  <button type="button" className="exploration-link" onClick={() => parent && selectNode(parent)}>
                    {parent?.title}
                  </button>
                  {edge.description && `——${edge.description}`}
                </p>
              );
            })}
            {!node.bodyMarkdown && (
              <section className="exploration-history-changes" aria-label="这一步改了什么">
                <h4>这一步改了什么</h4>
                {node.changes.map((item, index) => (
                  <div key={`${item.label}:${index}`}>
                    <strong>{item.label}</strong>
                    <p>{item.detail}</p>
                    <EvolutionSource label="依据" source={item.sourceRef} href={item.ownerHref} />
                  </div>
                ))}
              </section>
            )}
            <ExplorationHistoryCases key={nodeKey} workspace={workspace} />
            {next && (
              <button
                type="button"
                className="exploration-link exploration-history-next"
                onClick={() => selectNode(next)}
              >
                下一步 → {next.title}
              </button>
            )}
            <details className="exploration-adoption">
              <summary>采用与来源（技术记录）</summary>
              <p>当前采用：{names('adopted') || '未登记'}</p>
              <p>来源当前版本：{asset.catalog ? names('sourceCurrent') || '未登记' : '待来源核验'}</p>
              <EvolutionSource label="历史来源版本" source={node.sourceRef} />
              {node.sources?.map((source, index) => (
                <EvolutionSource
                  key={`${refIdentity(source.ref)}:${index}`}
                  label={source.label}
                  source={source.ref}
                  href={source.href}
                />
              ))}
              <ExplorationHistoryPublicationRecords workspace={workspace} />
              {experiment && <ExplorationConditions experiment={experiment} />}
            </details>
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
          </>
        )}
      </article>
    </section>
  );
}
