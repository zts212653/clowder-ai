'use client';

import { type ExactAssetVersionRefV1, refIdentity } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  createCapabilityEvolutionWorkspaceSurface,
  isCapabilityEvolutionWorkspaceSurface,
  resolveCapabilityEvolutionTargetThreadId,
} from '@/components/workbench/capability-evolution-workspace-adapter';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createEvolutionProgramSurface } from '@/components/workbench/real-surface-adapters';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useChatStore } from '@/stores/chatStore';
import { CapabilityEvolutionProgramDetail } from './CapabilityEvolutionProgramDetail';
import { CapabilityEvolutionWorkspace } from './CapabilityEvolutionWorkspace';
import { evolutionProgramPresentation, productStatus } from './capability-evolution-presentation';
import { EvolutionChangePanel } from './EvolutionChangePanel';
import { EvolutionJourney, journeyMoment } from './EvolutionJourney';
import { RawDetails } from './EvolutionProgramContext';
import { EvolutionProgramName } from './EvolutionProgramName';
import { EvolutionProgramOrigin } from './EvolutionProgramOrigin';
import { EvolutionActualUse, EvolutionSource, EvolutionVersionEvidence } from './EvolutionVersionEvidence';
import { EvolutionVersionHistory } from './EvolutionVersionHistory';
import { useEvolutionAssetReview } from './evolution-asset-resource';
import { evolutionReadingHref } from './evolution-navigation';
import { acceptProgramProjection, useEvolutionPrograms } from './evolution-program-resource';
import { pendingOwnerRead } from './evolution-read-status';
import {
  DEFAULT_READING,
  type EvolutionReadingView,
  navigateEvolutionVersion,
  openEvolutionReading,
  useEvolutionReading,
} from './evolution-reading-state';
import { projectAssetVersions, selectedAssetVersion } from './evolution-version-view';
import { ExplorationOwnerEvidence } from './exploration/ExplorationOwnerEvidence';
import { EvolutionMomentContext } from './journey/EvolutionMomentContext';
import { EvolutionProgressAction } from './journey/EvolutionProgressAction';
import { useEvolutionLifecycle } from './use-evolution-lifecycle';
import { useEvolutionOwnerReadingDefault } from './use-evolution-owner-reading-default';
import { useEvolutionScroll } from './use-evolution-scroll';
import './evolution-workspace.css';
import './preparation/evolution-preparation.css';
import './preparation/evolution-preparation-visual.css';
import './preparation/evolution-preparation.responsive.css';
import './exploration/exploration.css';
import './exploration/exploration-responsive.css';

export function EvolutionProgramList({ onOpenProgram }: { onOpenProgram: (programId: string) => void }) {
  return <CapabilityEvolutionWorkspace targetThreadId={null} onOpenProgram={onOpenProgram} />;
}

export function EvolutionProgramSurface({ programId }: { programId: string }) {
  const { projection, error, reload } = useEvolutionPrograms(programId);
  const reading = useEvolutionReading((state) => state.programs[programId] ?? DEFAULT_READING);
  const update = useEvolutionReading((state) => state.update);
  const asset = useEvolutionAssetReview(projection, reading.selectedVersionRef);
  const lifecycle = useEvolutionLifecycle(projection);
  const surfaceId = createEvolutionProgramSurface(programId).id;
  useEffect(() => {
    const store = useF307ExperienceWorkbenchStore.getState();
    const descriptor = createEvolutionProgramSurface(programId, projection?.program.displayName, projection?.origin);
    const existing = store.layout.surfaces.find((surface) => surface.id === descriptor.id) ?? store.layout.sidecar;
    if (
      existing?.id === descriptor.id &&
      (existing.title !== descriptor.title || existing.context !== descriptor.context)
    )
      store.dispatch({ type: 'refresh-surface', surface: descriptor });
  }, [programId, projection?.program.displayName, projection?.origin]);
  const main = useF307ExperienceWorkbenchStore((state) => state.mainAreaAttentionSurfaceId === surfaceId);
  const desktop = useIsDesktop();
  const [expanded, setExpanded] = useState(false);
  const reviewing = main || (!desktop && expanded);
  useEffect(() => {
    if (main) setExpanded(true);
  }, [main]);
  const versions = useMemo(
    () => (projection ? projectAssetVersions(projection, asset.catalog) : []),
    [projection, asset.catalog],
  );
  const readStatus =
    asset.error || asset.review?.blockers.length
      ? 'unavailable'
      : asset.loading
        ? 'loading'
        : asset.catalog
          ? 'resolved'
          : 'unavailable';
  const selectedKey = reading.selectedVersionRef ? refIdentity(reading.selectedVersionRef) : undefined;
  const selected = selectedAssetVersion(versions, selectedKey);
  const selectedReview =
    asset.review?.status === 'resolved' &&
    selected &&
    asset.review.selected &&
    refIdentity(asset.review.selected.versionRef) === refIdentity(selected.ref)
      ? asset.review.selected
      : undefined;
  const scrollKey = reviewing ? reading.view : 'detail';
  const { viewport, onScroll } = useEvolutionScroll(programId, scrollKey, projection !== null);
  useEvolutionOwnerReadingDefault(programId, selectedReview?.versionRef);
  const select = (ref: ExactAssetVersionRefV1) => navigateEvolutionVersion(programId, ref);
  const openPreparation = () => update(programId, { journeyMoment: 1, view: 'judgment' });
  const open = (_id: string, view: EvolutionReadingView = 'judgment') => {
    openEvolutionReading(programId, view);
    setExpanded(true);
    if (desktop) useF307ExperienceWorkbenchStore.getState().enterMainAreaAttention(surfaceId);
  };
  const returnToRail = () => {
    setExpanded(false);
    useF307ExperienceWorkbenchStore.getState().exitMainAreaAttention();
  };
  const backToWorkspace = () => {
    const store = useF307ExperienceWorkbenchStore.getState();
    const home =
      [...store.layout.surfaces, ...(store.layout.sidecar ? [store.layout.sidecar] : [])].find(
        isCapabilityEvolutionWorkspaceSurface,
      ) ?? createCapabilityEvolutionWorkspaceSurface(useChatStore.getState().currentThreadId ?? undefined);
    useEvolutionReading
      .getState()
      .selectWorkspaceProgram(resolveCapabilityEvolutionTargetThreadId(home) ?? 'global', null);
    if (store.layout.sidecar?.id === home.id) {
      returnToRail();
      return;
    }
    store.dispatch({ type: 'open-surface', surface: home, entitlement: { kind: 'user', reason: 'surface-tab' } });
  };
  if (!projection)
    return (
      <div
        ref={viewport}
        className="evolution-workspace min-h-0 flex-1 overflow-y-auto"
        data-testid="evolution-program-surface"
        data-reading-view={scrollKey}
      >
        <div className="evolution-content">
          <header>
            <button
              type="button"
              className="text-xs text-cafe-secondary"
              onClick={reviewing ? returnToRail : backToWorkspace}
            >
              {reviewing ? (desktop ? '← 返回侧栏' : '← 返回详情') : '← 能力进化'}
            </button>
            <p className="evolution-eyebrow mt-6">能力进化 · 项目记录</p>
            <h1 className="evolution-title mt-2">{createEvolutionProgramSurface(programId).title}</h1>
          </header>
          <p role="status" className="evolution-empty mt-5">
            {error ?? '正在读取能力进化记录…'}
          </p>
          {error && (
            <button type="button" className="evolution-link mt-4" onClick={() => void reload()}>
              重试
            </button>
          )}
        </div>
      </div>
    );
  const status = productStatus(projection);
  const moment = reading.journeyMoment ?? journeyMoment(projection);
  const showVersions = reading.view === 'history' || moment === 3;
  const controls = (
    <details className="relative text-xs text-cafe-secondary">
      <summary className="cursor-pointer">更多</summary>
      <div className="absolute right-0 top-6 z-10 w-36 rounded-lg border border-cafe-subtle bg-cafe-surface p-2 shadow-sm">
        {projection.program.lifecycle === 'active' && (
          <button
            className="w-full p-2 text-left"
            type="button"
            disabled={lifecycle.pending}
            onClick={() => void lifecycle.run('pause')}
          >
            暂停项目
          </button>
        )}
        {projection.program.lifecycle === 'paused' && (
          <button
            className="w-full p-2 text-left"
            type="button"
            disabled={lifecycle.pending}
            onClick={() => void lifecycle.run('resume')}
          >
            恢复项目
          </button>
        )}
        {projection.program.lifecycle !== 'active' && projection.program.lifecycle !== 'paused' && (
          <p className="p-2">记录已保留</p>
        )}
      </div>
    </details>
  );
  return (
    <div
      ref={viewport}
      className="evolution-workspace min-h-0 flex-1 overflow-y-auto"
      data-testid="evolution-program-surface"
      data-reading-view={reviewing ? reading.view : 'detail'}
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
    >
      <div
        className="evolution-content"
        data-exploration-focus={reviewing && moment === 2 && reading.view === 'judgment'}
      >
        {!reviewing ? (
          <CapabilityEvolutionProgramDetail
            projection={projection}
            onClose={backToWorkspace}
            onOpenProgram={open}
            controls={controls}
          />
        ) : (
          <>
            <header>
              <div className="mb-6 flex items-center justify-between">
                <button type="button" className="text-xs text-cafe-secondary" onClick={returnToRail}>
                  {desktop ? '← 返回侧栏' : '← 返回详情'}
                </button>
                {controls}
              </div>
              <p className="evolution-eyebrow">
                能力进化 · 第 {projection.program.cycle} 轮 · {status.label}
              </p>
              <h1 className="evolution-title mt-2">
                {evolutionProgramPresentation(projection.program, projection.origin).title}
              </h1>
              <EvolutionProgramOrigin projection={projection} />
              <EvolutionProgramName projection={projection} />
              <EvolutionJourney projection={projection} />
            </header>
            <EvolutionProgressAction projection={projection} compact={moment === 2} />
            <div role="tablist" aria-label="项目阅读内容" className="evolution-tabs">
              {(['judgment', 'history'] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  role="tab"
                  aria-selected={reading.view === view}
                  onClick={() => update(programId, { view })}
                >
                  {view === 'judgment' ? (moment === 2 ? '探索工作面' : '本轮判断') : '更改历史'}
                </button>
              ))}
            </div>
            <div className={showVersions ? 'evolution-review-grid' : 'space-y-6'}>
              <div className="min-w-0 space-y-6">
                {reading.view === 'history' ? (
                  <EvolutionVersionHistory
                    projection={projection}
                    versions={versions}
                    selectedKey={selectedKey}
                    onSelect={select}
                    review={asset.catalog}
                    selectedReview={selectedReview}
                    readStatus={readStatus}
                    onOpenPreparation={openPreparation}
                  />
                ) : (
                  <EvolutionMomentContext
                    projection={projection}
                    moment={moment}
                    onSelectCandidate={select}
                    onOpenPreparation={openPreparation}
                    explorationMode="workspace"
                  >
                    {moment >= 2 && (
                      <EvolutionChangePanel projection={projection} onProjection={acceptProgramProjection} />
                    )}
                    {moment === 2 && (
                      <ExplorationOwnerEvidence
                        asset={asset}
                        versionRef={reading.selectedVersionRef}
                        onSelect={(ref) => update(programId, { selectedVersionRef: ref })}
                      />
                    )}
                    {moment === 3 && <EvolutionActualUse selected={selectedReview} readStatus={readStatus} />}
                  </EvolutionMomentContext>
                )}
                <RawDetails projection={projection} />
              </div>
              {showVersions && (
                <aside className="min-w-0 space-y-6">
                  <section aria-label="阅读版本">
                    <h2 className="text-sm font-semibold text-cafe">阅读版本</h2>
                    {versions.length ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {versions.map((version) => (
                          <button
                            key={refIdentity(version.ref)}
                            type="button"
                            aria-pressed={selectedKey === refIdentity(version.ref)}
                            onClick={() => select(version.ref)}
                            className="rounded-lg border border-cafe-subtle px-3 py-2 text-left text-xs text-cafe-secondary aria-pressed:border-cafe-accent"
                          >
                            <span className="block font-semibold text-cafe">
                              {asset.catalog?.versions.find(
                                (item) => refIdentity(item.versionRef) === refIdentity(version.ref),
                              )?.title ?? version.ref.version}
                              {version.current && <span className="ml-2">当前采用</span>}
                            </span>
                            <span className="mt-1 block break-all font-mono text-cafe-muted">
                              {version.ref.version}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="evolution-empty mt-3">
                        {asset.catalog ? '资产来源尚未提供版本记录。' : pendingOwnerRead(readStatus, '版本记录')}
                      </p>
                    )}
                    {asset.catalog && <EvolutionSource label="采用来源" source={asset.catalog.currentProofRef} />}
                    {selected && typeof window !== 'undefined' && (
                      <a
                        data-testid="evolution-version-link"
                        className="evolution-link mt-3 inline-block"
                        href={evolutionReadingHref(
                          { programId, view: reading.view, versionRef: selected.ref },
                          window.location.href,
                        )}
                      >
                        此版本的来源链接
                      </a>
                    )}
                  </section>
                  <EvolutionVersionEvidence selected={selectedReview} readStatus={readStatus} />
                  {reading.view === 'history' && (
                    <EvolutionActualUse selected={selectedReview} readStatus={readStatus} />
                  )}
                  {asset.error && (
                    <p role="status" className="evolution-empty">
                      {asset.error}
                    </p>
                  )}
                </aside>
              )}
            </div>
          </>
        )}
        {lifecycle.notice && (
          <p role="status" data-notice-code="program_state_synchronized" className="evolution-empty mt-5">
            {lifecycle.notice}
          </p>
        )}
        {error && (
          <p role="status" className="evolution-empty mt-4">
            读取暂时中断，正在显示最近一次记录。
          </p>
        )}
      </div>
    </div>
  );
}
