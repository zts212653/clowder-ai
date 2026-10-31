'use client';

import { type EvolutionResolvedAssetReviewV1, type ExactAssetVersionRefV1, refIdentity } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { EvolutionPhaseGaps } from './CapabilityEvolutionHomeV2';
import {
  type EvolutionProgramPresentationProjection,
  evolutionProgramPresentation,
  productStatus,
} from './capability-evolution-presentation';
import { EvolutionJourney, journeyMoment, MOMENTS } from './EvolutionJourney';
import { EvolutionOwnerEvidence } from './EvolutionOwnerEvidence';
import { RawDetails } from './EvolutionProgramContext';
import { EvolutionProgramName } from './EvolutionProgramName';
import { EvolutionProgramOrigin } from './EvolutionProgramOrigin';
import { EvolutionActualUse, EvolutionSource } from './EvolutionVersionEvidence';
import { useEvolutionAssetReview } from './evolution-asset-resource';
import {
  DEFAULT_READING,
  type EvolutionReadingView,
  openEvolutionReading,
  useEvolutionReading,
} from './evolution-reading-state';
import { projectAssetVersions, selectedAssetVersion } from './evolution-version-view';
import { EvolutionMomentContext } from './journey/EvolutionMomentContext';
import { EvolutionProgressAction } from './journey/EvolutionProgressAction';
import { EvolutionPreparationOverview } from './preparation/EvolutionPreparationOverview';
import { useEvolutionOwnerReadingDefault } from './use-evolution-owner-reading-default';

function CurrentAdoption({
  catalog,
  versions,
  loading,
}: {
  catalog?: EvolutionResolvedAssetReviewV1;
  versions: ReturnType<typeof projectAssetVersions>;
  loading: boolean;
}) {
  const adopted = versions.filter((version) => version.adopted);
  const sourceCurrent = versions.filter((version) => version.sourceCurrent);
  const title = (ref: ExactAssetVersionRefV1) =>
    catalog?.versions.find((version) => refIdentity(version.versionRef) === refIdentity(ref))?.title;
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-xs font-semibold text-cafe-secondary">当前采用</h3>
        {adopted.length ? (
          adopted.map(({ ref }) => (
            <div key={refIdentity(ref)} className="mt-2">
              <p className="break-words text-sm font-semibold text-cafe">{title(ref) ?? ref.assetId}</p>
              <EvolutionSource label="版本标识" source={ref} />
            </div>
          ))
        ) : (
          <p className="evolution-empty mt-2">本项目尚无采用记录。</p>
        )}
      </div>
      <div>
        <h3 className="text-xs font-semibold text-cafe-secondary">来源当前版本</h3>
        {catalog ? (
          sourceCurrent.length ? (
            sourceCurrent.map(({ ref }) => (
              <div key={refIdentity(ref)} className="mt-2">
                <p className="break-words text-sm font-semibold text-cafe">{title(ref) ?? ref.assetId}</p>
                <EvolutionSource label="版本标识" source={ref} />
              </div>
            ))
          ) : (
            <p className="evolution-empty mt-2">来源尚未登记当前版本。</p>
          )
        ) : (
          <p className="evolution-empty mt-2">{loading ? '正在读取资产来源…' : '来源当前版本尚待确认。'}</p>
        )}
        {catalog && <EvolutionSource label="来源当前版本证明" source={catalog.currentProofRef} />}
        <p className="evolution-empty mt-2">来源当前版本不等于本项目已采用。</p>
      </div>
    </div>
  );
}

function ownerReadStatus(asset: ReturnType<typeof useEvolutionAssetReview>) {
  if (asset.error || asset.review?.blockers.length) return 'unavailable' as const;
  if (asset.loading) return 'loading' as const;
  return asset.catalog ? ('resolved' as const) : ('unavailable' as const);
}

function EvolutionEvaluationStatus({
  projection,
  whileReadingHistory = false,
}: {
  projection: EvolutionProgramPresentationProjection;
  whileReadingHistory?: boolean;
}) {
  return (
    <aside className="evolution-v2-phase-note" aria-label={whileReadingHistory ? '项目效果评估状态' : undefined}>
      <strong>
        {whileReadingHistory ? '项目效果评估仍待补证' : `${MOMENTS[journeyMoment(projection)]}这一阶段还缺`}
      </strong>
      <p>
        <EvolutionPhaseGaps projection={projection} />
      </p>
      {whileReadingHistory && <p>这些缺口用于判断改进是否有效，不是查看已发布探索记录的前置条件。</p>}
    </aside>
  );
}

export function CapabilityEvolutionProgramDetail({
  projection,
  onClose,
  onOpenProgram,
  controls,
}: {
  projection: EvolutionProgramPresentationProjection;
  onClose: () => void;
  onOpenProgram: (programId: string, view?: EvolutionReadingView) => void;
  controls?: ReactNode;
}) {
  const v2 = useShellPresentation() === 'v2';
  const id = projection.program.programId;
  const reading = useEvolutionReading((state) => state.programs[id] ?? DEFAULT_READING);
  const updateReading = useEvolutionReading((state) => state.update);
  const asset = useEvolutionAssetReview(projection, reading.selectedVersionRef);
  const versions = projectAssetVersions(projection, asset.catalog);
  const selectedKey = reading.selectedVersionRef ? refIdentity(reading.selectedVersionRef) : undefined;
  const selected = selectedAssetVersion(versions, selectedKey);
  useEvolutionOwnerReadingDefault(
    id,
    selected && asset.review?.status === 'resolved' ? asset.review.selected?.versionRef : undefined,
  );
  const target = evolutionProgramPresentation(projection.program, projection.origin);
  const status = productStatus(projection);
  const moment = reading.journeyMoment ?? journeyMoment(projection);
  const change = projection.lineage?.current;
  const candidateTitle = change
    ? asset.catalog?.versions.find(
        (version) => refIdentity(version.versionRef) === refIdentity(change.targetVersionRef),
      )?.title
    : undefined;
  const open = (view: EvolutionReadingView, exactVersionRef?: ExactAssetVersionRefV1) => {
    openEvolutionReading(id, view, exactVersionRef);
    onOpenProgram(id, view);
  };
  const select = (ref: ExactAssetVersionRefV1) => open('judgment', ref);
  const openPreparation = () => updateReading(id, { journeyMoment: 1, view: 'judgment' });
  return (
    <section data-testid="capability-evolution-program-detail">
      <div className="mb-6 flex items-center justify-between gap-3">
        <button type="button" className="text-xs text-cafe-secondary hover:underline" onClick={onClose}>
          ← 全部项目
        </button>
        {controls}
      </div>
      <p className="evolution-eyebrow">能力进化 · 第 {projection.program.cycle} 轮</p>
      <h2 className="evolution-title mt-2">{v2 ? (projection.program.displayName ?? '尚未命名') : target.title}</h2>
      <EvolutionProgramOrigin projection={projection} />
      <EvolutionProgramName projection={projection} />
      <EvolutionJourney projection={projection} />
      <EvolutionProgressAction projection={projection} compact={v2 || moment === 2} />
      {v2 && (
        <>
          {moment !== 2 && <EvolutionEvaluationStatus projection={projection} />}
          <div role="tablist" aria-label="项目阅读内容" className="evolution-tabs">
            <button
              type="button"
              role="tab"
              aria-selected={reading.view === 'judgment'}
              onClick={() => updateReading(id, { view: 'judgment' })}
            >
              本轮判断
            </button>
            <button type="button" role="tab" aria-selected={reading.view === 'history'} onClick={() => open('history')}>
              更改历史
            </button>
          </div>
        </>
      )}
      <div className={v2 ? 'evolution-v2-moment' : 'evolution-focus'}>
        <p className="text-xs font-semibold text-cafe-secondary">{status.label}</p>
        {v2 && moment === 1 ? (
          <EvolutionPreparationOverview
            projection={projection}
            onOpen={(section) => {
              updateReading(id, { preparationSection: section });
              open('judgment');
            }}
          />
        ) : (
          <EvolutionMomentContext
            projection={projection}
            moment={moment}
            onSelectCandidate={select}
            onOpenPreparation={openPreparation}
          >
            {moment === 2 && change && <EvolutionSource label="候选来源" source={change.proposalRef} />}
            {moment >= 2 && (
              <EvolutionActualUse
                selected={asset.review?.status === 'resolved' ? asset.review.selected : undefined}
                readStatus={ownerReadStatus(asset)}
              />
            )}
          </EvolutionMomentContext>
        )}
        <button type="button" className="evolution-link mt-5" onClick={() => open('judgment')}>
          {v2 ? '在主区展开阅读' : '展开阅读 →'}
        </button>
      </div>
      {v2 && moment === 2 && <EvolutionEvaluationStatus projection={projection} whileReadingHistory />}
      {v2 ? (
        <details className="evolution-preparation-related">
          <summary>目标与评估来源</summary>
          <EvolutionOwnerEvidence projection={projection} />
        </details>
      ) : (
        <EvolutionOwnerEvidence projection={projection} />
      )}
      <section className="mt-6 space-y-5" aria-label="采用与候选">
        <CurrentAdoption catalog={asset.catalog} versions={versions} loading={asset.loading} />
        <div>
          <h3 className="text-xs font-semibold text-cafe-secondary">本轮候选</h3>
          <p className="evolution-empty mt-2">
            {change
              ? `${candidateTitle ? `基于「${candidateTitle}」的改动` : '基于来源新发布的改动'} · ${status.label}`
              : '正式改动尚未形成；来源发布的候选可在上方“探索进化”中阅读。'}
          </p>
          {change && <EvolutionSource label="候选版本" source={change.targetVersionRef} />}
          {change && <EvolutionSource label="候选来源" source={change.proposalRef} />}
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-cafe-subtle pt-5">
          <div>
            <h3 className="text-sm font-semibold text-cafe">更改历史</h3>
            <p className="mt-1 text-xs text-cafe-muted">
              {versions.length ? `${versions.length} 个已记录版本` : '还没有资产版本记录'}
            </p>
          </div>
          <button type="button" className="evolution-link" onClick={() => open('history')}>
            查看历史 →
          </button>
        </div>
      </section>
      {asset.error && <output className="evolution-empty mt-4 block">{asset.error}</output>}
      <RawDetails projection={projection} />
    </section>
  );
}
