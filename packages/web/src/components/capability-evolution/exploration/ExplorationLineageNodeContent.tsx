import type { EvolutionExplorationNodeV1 } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { ExplorationIcon } from './ExplorationIcon';
import { isHistoricalStep } from './exploration-history';

export function lineageDisplayTitle(node: EvolutionExplorationNodeV1): string {
  return isHistoricalStep(node) ? `${node.history.period} · ${node.title}` : node.title;
}

export function ExplorationLineageNodeTitle({ node }: { node: EvolutionExplorationNodeV1 }) {
  if (isHistoricalStep(node))
    return (
      <>
        <span className="exploration-node-period">{node.history.period}</span>
        <span className="exploration-node-heading">{node.title}</span>
      </>
    );
  return (
    <>
      <ExplorationIcon kind={node.kind === 'owner_version' ? 'code' : 'branch'} />
      <span className="exploration-node-heading">{lineageDisplayTitle(node)}</span>
    </>
  );
}

export function lineageSummary(node: EvolutionExplorationNodeV1, historical: boolean): ReactNode {
  if (historical) return null;
  return <span className="exploration-node-summary">{node.changes[0]?.detail ?? node.summary}</span>;
}

export function lineageNodeMeta(
  key: string,
  currentKeys: ReadonlySet<string>,
  adoptedKeys: ReadonlySet<string>,
  nodeNotes?: ReadonlyMap<string, string>,
): string | undefined {
  const labels = [];
  if (currentKeys.has(key)) labels.push('来源当前版本');
  if (adoptedKeys.has(key)) labels.push('当前采用');
  if (!labels.length && nodeNotes?.has(key)) labels.push(nodeNotes.get(key));
  return labels.filter((label): label is string => Boolean(label)).join(' · ') || undefined;
}
