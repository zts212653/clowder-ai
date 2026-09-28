'use client';

import { type EvolutionResolvedAssetReviewV1, type ExactAssetVersionRefV1, refIdentity } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import {
  type EvolutionProgramPresentationProjection,
  evolutionProgramPresentation,
  productStatus,
} from './capability-evolution-presentation';
import { EvolutionJourney, journeyMoment } from './EvolutionJourney';
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
import { useEvolutionOwnerReadingDefault } from './use-evolution-owner-reading-default';

function CurrentAdoption({
  catalog,
  programRefs,
  loading,
}: {
  catalog?: EvolutionResolvedAssetReviewV1;
  programRefs: EvolutionProgramPresentationProjection['program']['currentAssetVersionRefs'];
  loading: boolean;
}) {
  const current = catalog?.currentVersionRefs ?? [];
  return (
    <div>
      <h3 className="text-xs font-semibold text-cafe-secondary">当前采用</h3>
      {catalog ? (
        current.length ? (
          current.map((ref) => {
            const title = catalog.versions.find(
              (version) => refIdentity(version.versionRef) === refIdentity(ref),
            )?.title;
            return (
              <p key={refIdentity(ref)} className="mt-2 break-words text-sm text-cafe">
                <span className="block font-semibold">{title ?? ref.assetId}</span>
                <span className="mt-1 block break-all font-mono text-xs text-cafe-muted">{ref.version}</span>
              </p>
            );
          })
        ) : (
          <p className="evolution-empty mt-2">资产来源尚无采用记录。</p>
        )
      ) : (
        <p className="evolution-empty mt-2">{loading ? '正在读取资产来源…' : '当前采用尚待资产来源确认。'}</p>
      )}
      {!catalog && programRefs.length > 0 && (
        <p className="mt-2 text-xs text-cafe-muted">
          项目最近记录：{programRefs.map((ref) => ref.version ?? '未固定版本').join('、')}
        </p>
      )}
      {catalog && <EvolutionSource label="采用来源" source={catalog.currentProofRef} />}
    </div>
  );
}

function ownerReadStatus(asset: ReturnType<typeof useEvolutionAssetReview>) {
  if (asset.error || asset.review?.blockers.length) return 'unavailable' as const;
  if (asset.loading) return 'loading' as const;
  return asset.catalog ? ('resolved' as const) : ('unavailable' as const);
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
      <h2 className="evolution-title mt-2">{target.title}</h2>
      <EvolutionProgramOrigin projection={projection} />
      <EvolutionProgramName projection={projection} />
      <EvolutionJourney projection={projection} />
      <EvolutionProgressAction projection={projection} compact={moment === 2} />
      <div className="evolution-focus">
        <p className="text-xs font-semibold text-cafe-secondary">{status.label}</p>
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
        <button type="button" className="evolution-link mt-5" onClick={() => open('judgment')}>
          展开阅读 →
        </button>
      </div>
      <EvolutionOwnerEvidence projection={projection} />
      <section className="mt-6 space-y-5" aria-label="采用与候选">
        <CurrentAdoption
          catalog={asset.catalog}
          programRefs={projection.program.currentAssetVersionRefs}
          loading={asset.loading}
        />
        <div>
          <h3 className="text-xs font-semibold text-cafe-secondary">本轮候选</h3>
          <p className="evolution-empty mt-2">
            {change
              ? `基于 ${change.targetVersionRef.version} 的改动 · ${status.label}`
              : '正式改动尚未形成；来源发布的候选可在上方“探索进化”中阅读。'}
          </p>
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
