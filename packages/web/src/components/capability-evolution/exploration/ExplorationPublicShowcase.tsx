import {
  type EvolutionExplorationRecordV1,
  type EvolutionResolvedExplorationReviewV1,
  refIdentity,
} from '@cat-cafe/shared';
import { useMemo } from 'react';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { duckWalkObservation, walkObservationHref, walkObservationSource } from './duck-walk-observations';
import { ExplorationMedia } from './ExplorationMedia';
import { ExplorationPlaybackGroup } from './ExplorationPlaybackGroup';

import { type ShowcaseRow as Row, useExplorationShowcase } from './use-exploration-showcase';

function walkSummary(record: EvolutionExplorationRecordV1) {
  if (record.values.kick_time !== null && record.values.kick_time !== undefined)
    return `${record.values.kick_time.toFixed(1)}秒起脚 · ${record.result.label}`;
  const points = record.trace?.points;
  const start = points?.[0];
  const end = points?.at(-1);
  const moved = start && end ? Math.hypot(end.x - start.x, end.y - start.y) * 100 : undefined;
  return `${record.result.label}${moved !== undefined ? ` · 躯干首末位移${moved.toFixed(1)}cm` : ''}`;
}

/** A bounded reading deck of exact owner records, with no new catalog, adoption or persistent selection. */
export function ExplorationPublicShowcase({
  projection,
  catalog,
}: {
  projection: EvolutionProgramProjection;
  catalog: EvolutionResolvedExplorationReviewV1;
}) {
  const eligible =
    catalog.sourceRef.ownerFeatureId === 'microduck-owner' &&
    catalog.sourceRef.ownerStateRef.startsWith('duck-capability-publications:');
  const walk = useMemo(
    () =>
      ['v1', 'v2', 'v3', 'v4'].flatMap((label) => {
        const node = catalog.nodes.find(
          (node) =>
            node.kind === 'public_archive' &&
            node.title === label &&
            node.nodeRef.ownerStateRef.startsWith('public-controller:'),
        );
        const experiment =
          node &&
          catalog.experiments.find(
            (run) =>
              refIdentity(run.nodeRef) === refIdentity(node.nodeRef) &&
              run.experimentRef.ownerStateRef.startsWith(`public-run-20260907-approach-${label}:sha256:`),
          );
        return experiment ? [{ label, experiment, caseId: 'approach-left-far' }] : [];
      }),
    [catalog],
  );
  const cortex = useMemo(
    () =>
      catalog.experiments
        .filter((run) => run.experimentRef.ownerStateRef.startsWith('cortex-run:'))
        .map((experiment) => ({ label: experiment.title, experiment })),
    [catalog],
  );
  const rows: Row[] = [...walk, ...cortex];
  const { reads, retry } = useExplorationShowcase(projection, rows, eligible);
  const renderRows = (list: Row[]) =>
    list.map((row) => {
      const read = reads[refIdentity(row.experiment.experimentRef)];
      return (
        <article key={refIdentity(row.experiment.experimentRef)} data-showcase-version={row.label}>
          {read?.record ? (
            <>
              <ExplorationMedia programId={projection.program.programId} record={read.record} onRetry={retry} />
              <p>
                {row.caseId
                  ? `录像观察：${duckWalkObservation(row.label, read.record) ?? walkSummary(read.record)}`
                  : read.record.result.label}
              </p>
              {row.caseId && duckWalkObservation(row.label, read.record) && (
                <EvolutionSource
                  label="录像观察出处（不是冻结判据）"
                  source={walkObservationSource}
                  href={walkObservationHref}
                />
              )}
              <EvolutionSource
                label="原件与条件"
                source={row.experiment.sourceRef}
                href={read.record.sources[0]?.href}
              />
            </>
          ) : (
            <output>{read?.error ?? '正在读取本场景的完整原始记录…'}</output>
          )}
        </article>
      );
    });
  if (!eligible) return null;
  return (
    <section className="exploration-public-showcase" aria-label="公开归档可视结果">
      {walk.length === 4 && (
        <section aria-label="同一场景逐版看走路">
          <h3>同一场景逐版看走路 · 左侧远球</h3>
          <p>v1–v4 的原20秒记录。展示走路与起脚的差别，未碰到球仍明确保留；不是整体能力改善或独立验证。</p>
          <ExplorationPlaybackGroup enabled expectedPlayers={4}>
            {renderRows(walk)}
          </ExplorationPlaybackGroup>
        </section>
      )}
      {cortex.length === 2 && (
        <section aria-label="两场整场比赛">
          <h3>Cortex · 两场整场比赛，联看前10秒</h3>
          <p>局部观察与控制组合 sensor → state；源码和120/240秒观察窗也不同。两场是实验，不是版本父边或单变量改善。</p>
          <ExplorationPlaybackGroup enabled stopAtSeconds={10}>
            {renderRows(cortex)}
          </ExplorationPlaybackGroup>
        </section>
      )}
      <button type="button" onClick={retry}>
        重新读取这组原件
      </button>
    </section>
  );
}
