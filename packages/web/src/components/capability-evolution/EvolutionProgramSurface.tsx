'use client';

import { type ExactAssetVersionRefV1, refIdentity } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { DEFAULT_ARTIFACT_WORK_CHAT_BASIS } from '@/components/workbench/artifact-work-presentation';
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
import { EvolutionChangePanel } from './EvolutionChangePanel';
import { journeyMoment } from './EvolutionJourney';
import { EvolutionLifecycleControls } from './EvolutionLifecycleControls';
import { RawDetails } from './EvolutionProgramContext';
import { EvolutionReadingHeader } from './EvolutionReadingHeader';
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
import './evolution-v2.css';
import './preparation/evolution-preparation-v2.css';
import './preparation/evolution-preparation.css';
import './preparation/evolution-preparation-visual.css';
import './preparation/evolution-preparation.responsive.css';
import './exploration/exploration.css';
import './exploration/exploration-responsive.css';

export function EvolutionProgramList({ onOpenProgram }: { onOpenProgram: (programId: string) => void }) {
  return <CapabilityEvolutionWorkspace targetThreadId={null} onOpenProgram={onOpenProgram} />;
}

function enterProgramReading(surfaceId: string, desktop: boolean): void {
  if (!desktop) return;
  const threadId = useChatStore.getState().currentThreadId;
  useF307ExperienceWorkbenchStore
    .getState()
    .enterMainAreaAttention(
      surfaceId,
      threadId ? { kind: 'chat-workspace', threadId, chatBasis: DEFAULT_ARTIFACT_WORK_CHAT_BASIS } : undefined,
    );
}

function returnFromProgramReading(): void {
  const store = useF307ExperienceWorkbenchStore.getState();
  if (
    store.mainAreaAttentionPresentation.kind === 'chat-workspace' &&
    store.mainAreaAttentionPresentation.mode === 'full-window'
  ) {
    store.returnFromMainAreaFullWindow();
    return;
  }
  store.exitMainAreaAttention();
}

export function EvolutionProgramSurface({ programId }: { programId: string }) {
  const v2 = useShellPresentation() === 'v2';
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
  const attentionPresentation = useF307ExperienceWorkbenchStore((state) => state.mainAreaAttentionPresentation);
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
    enterProgramReading(surfaceId, desktop);
  };
  const returnToRail = () => {
    setExpanded(false);
    returnFromProgramReading();
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
  const moment = reading.journeyMoment ?? journeyMoment(projection);
  const showVersions = reading.view === 'history' || moment === 3;
  const controls = <EvolutionLifecycleControls projection={projection} lifecycle={lifecycle} />;
  return (
    <div
      ref={viewport}
      className="evolution-workspace min-h-0 flex-1 overflow-y-auto"
      data-testid="evolution-program-surface"
      data-evolution-presentation={v2 ? 'v2' : 'classic'}
      data-reading-view={reviewing ? reading.view : 'detail'}
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
    >
      <div className="evolution-content" data-exploration-focus={reviewing && moment === 2}>
        {!reviewing ? (
          <CapabilityEvolutionProgramDetail
            projection={projection}
            onClose={backToWorkspace}
            onOpenProgram={open}
            controls={controls}
          />
        ) : (
          <>
            <EvolutionReadingHeader
              projection={projection}
              controls={controls}
              returnToRail={returnToRail}
              desktop={desktop}
              fullWindow={
                attentionPresentation.kind === 'chat-workspace' && attentionPresentation.mode === 'full-window'
              }
              moment={moment}
              v2={v2}
            />
            {moment !== 2 && !(v2 && moment === 1) && <EvolutionProgressAction projection={projection} />}
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
                              {version.sourceCurrent && <span className="ml-2">来源当前版本</span>}
                              {version.adopted && <span className="ml-2">当前采用</span>}
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
                    {asset.catalog && (
                      <EvolutionSource label="来源当前版本证明" source={asset.catalog.currentProofRef} />
                    )}
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
