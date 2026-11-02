'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { useArtworkLightboxScope } from '@/components/content-review/ArtworkLightboxScope';
import { useArtifactLightbox } from '@/components/content-review/useArtifactLightbox';
import { WorksIcon } from '@/components/shell/ShellIcons';
import { useShellCopy } from '@/components/shell/shell-copy';
import {
  canonicalLauncherDestination,
  type WorkspaceLauncherDestination,
} from '@/components/workspace/WorkspaceLauncher';
import { useCatData } from '@/hooks/useCatData';
import { useThreadArtifacts } from '@/hooks/useThreadArtifacts';
import { artifactObjectId } from '../workbench/real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from '../workbench/workbench-contract';
import { artifactCardMetadata } from './artifact-card-metadata';
import { WorkCard } from './HomeWorkCard';
import { captureHomeArtifactOrigin, type WorkspaceHomeArtifactOrigin } from './home-artifact-origin';
import { workspaceV3Copy } from './workspace-v3.shell-copy';

export type OpenHomeArtifact = (
  artifact: ThreadArtifactDTO,
  origin: WorkspaceHomeArtifactOrigin,
  surface: WorkspaceSurfaceDescriptor,
) => void;

type HomeWorksSummaryProps = {
  threadId?: string;
  worktreeId: string | null;
  onSelectDestination: (destination: WorkspaceLauncherDestination) => void;
  onOpenArtifact?: OpenHomeArtifact;
  returnArtifactId?: string;
};

function artifactReturnState(requested: boolean, loading: boolean, unavailable: boolean) {
  if (!requested) return undefined;
  if (loading) return 'pending';
  return unavailable ? 'unavailable' : 'ready';
}

function selectVisibleHomeWorks(
  artifacts: readonly ThreadArtifactDTO[],
  primary: readonly ThreadArtifactDTO[],
  returnArtifactId: string | undefined,
  localEntryId: string | undefined,
) {
  const retainedIds = new Set([returnArtifactId, localEntryId]);
  const retained = artifacts.filter((artifact) => retainedIds.has(artifactObjectId(artifact)));
  // Both owners need their exact card. Retain distinct keys, then fill the three-card summary in catalogue order.
  const visibleIds = new Set(retained.map(artifactObjectId));
  for (const artifact of primary) {
    if (visibleIds.size === 3) break;
    visibleIds.add(artifactObjectId(artifact));
  }
  return [
    ...primary,
    ...retained.filter((item) => !primary.some((p) => artifactObjectId(p) === artifactObjectId(item))),
  ].filter((artifact) => visibleIds.has(artifactObjectId(artifact)));
}

function WorksCatalogue({
  loading,
  error,
  empty,
  children,
}: {
  loading: boolean;
  error: boolean;
  empty: boolean;
  children: ReactNode;
}) {
  const t = useShellCopy(workspaceV3Copy);
  if (loading) return <output className="text-xs">{t.worksLoading}</output>;
  if (error) return <output className="text-xs">{t.worksUnavailable}</output>;
  if (empty) return <output className="text-xs text-cafe-muted">{t.worksEmpty}</output>;
  return children;
}

type HomeOriginFocus = { threadId: string; artifactId: string; viewport: HTMLElement };
function useNativeHomeFocus(threadId: string | undefined, originFocus: RefObject<HomeOriginFocus | null>) {
  const floatingWork = useArtworkLightboxScope()?.work;
  const previousFloatingWork = useRef(floatingWork);
  // The native dialog can outlive a pending catalogue read and its original DOM
  // button. Home owns finding the exact replacement; the media owner stays unchanged.
  useEffect(() => {
    const previous = previousFloatingWork.current;
    previousFloatingWork.current = floatingWork;
    const from = previous?.surface?.navigationOrigin;
    const entry = originFocus.current;
    if (
      floatingWork ||
      from?.kind !== 'workspace-home-artifact' ||
      from.threadId !== threadId ||
      !entry ||
      entry.threadId !== threadId ||
      entry.artifactId !== from.artifactId ||
      !entry.viewport.isConnected ||
      document.activeElement !== document.body
    )
      return;
    const card = [...entry.viewport.querySelectorAll<HTMLButtonElement>('[data-home-artifact-id]')].find(
      (node) => node.getAttribute('data-home-artifact-id') === entry.artifactId,
    );
    card?.focus({ preventScroll: true });
  }, [floatingWork, threadId, originFocus]);
}

function ThreadWorksSummary({
  threadId,
  worktreeId,
  onSelectDestination,
  onOpenArtifact,
  returnArtifactId,
}: HomeWorksSummaryProps) {
  const t = useShellCopy(workspaceV3Copy);
  const { getCatById } = useCatData();
  const { artifacts, works, total, complete, loading, error } = useThreadArtifacts(threadId, 'works');
  const floating = useArtifactLightbox(threadId ?? '', onOpenArtifact, {
    items: artifacts,
    complete: complete && !loading && !error,
  });
  const [unavailable, setUnavailable] = useState(false);
  const origin = useRef<WorkspaceHomeArtifactOrigin | null>(null);
  const originFocus = useRef<HomeOriginFocus | null>(null);
  useNativeHomeFocus(threadId, originFocus);
  const returned = returnArtifactId
    ? artifacts.find((artifact) => artifactObjectId(artifact) === returnArtifactId)
    : undefined;
  const visible = selectVisibleHomeWorks(artifacts, works, returnArtifactId, originFocus.current?.artifactId);
  const returnUnavailable = !!returnArtifactId && !loading && (error || !returned);
  const metadata = (artifact: ThreadArtifactDTO) => {
    const cat = artifact.catId ? getCatById(artifact.catId) : undefined;
    const author = cat?.nickname?.trim() || cat?.displayName || artifact.catId || t.unknownAuthor;
    return artifactCardMetadata(artifact, author, t);
  };
  const open = (artifact: ThreadArtifactDTO, card: HTMLButtonElement) => {
    const viewport = card.closest<HTMLElement>('[data-testid="f307-workspace-home-page"]');
    if (!threadId || !viewport) {
      setUnavailable(true);
      return;
    }
    origin.current = captureHomeArtifactOrigin(threadId, artifact, card, viewport);
    originFocus.current = { threadId, artifactId: artifactObjectId(artifact), viewport };
    setUnavailable(false);
    const navigationOrigin = origin.current;
    floating.open(artifact, navigationOrigin, artifacts);
  };

  return (
    <section
      className="home-section"
      aria-labelledby="home-works-title"
      data-home-artifact-return={artifactReturnState(!!returnArtifactId, loading, returnUnavailable)}
    >
      <header className="home-card-head">
        <WorksIcon className="home-section-icon" />
        <h2 id="home-works-title" className="home-card-title text-sm">
          {t.works}
        </h2>
        <span className="text-xs text-cafe-muted">
          {!error && complete && total !== null ? t.threadCount(total) : ''}
        </span>
        <button
          type="button"
          className="home-all shell-focusable ml-auto text-xs"
          onClick={() => onSelectDestination({ ...canonicalLauncherDestination('mode', 'artifacts'), label: t.works })}
        >
          {t.all} ›
        </button>
      </header>
      {!loading && !error && !complete && <output className="text-xs text-cafe-muted">{t.worksIncomplete}</output>}
      <WorksCatalogue loading={loading} error={error} empty={complete && artifacts.length === 0}>
        {floating.error && <p role="alert">{floating.error}</p>}
        <div className="home-works">
          {visible.map((artifact, index) => (
            <WorkCard
              key={artifactObjectId(artifact)}
              artifact={artifact}
              summary={index > 0 || artifact.type !== 'image' || !artifact.url}
              worktreeId={worktreeId}
              metadata={metadata(artifact)}
              current={artifactObjectId(artifact) === returnArtifactId}
              onSelect={(card) => open(artifact, card)}
            />
          ))}
        </div>
      </WorksCatalogue>
      {(returnUnavailable || unavailable) && <output className="text-xs">{t.unavailable}</output>}
      {floating.error && <output role="alert">{floating.error}</output>}
      {floating.lightbox}
    </section>
  );
}

export function HomeWorksSummary(props: HomeWorksSummaryProps) {
  return <ThreadWorksSummary key={props.threadId ?? 'no-thread'} {...props} />;
}
