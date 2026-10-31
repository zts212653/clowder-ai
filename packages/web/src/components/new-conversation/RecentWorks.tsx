'use client';
import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProgressiveWorks } from '@/components/artifacts/useProgressiveWorks';
import { WorkGalleryCard } from '@/components/artifacts/WorkGalleryCard';
import { useCatData } from '@/hooks/useCatData';
import { useGlobalArtifacts } from '@/hooks/useGlobalArtifacts';
import { resolveCatNameplateName } from '@/lib/cat-display-name';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { ShellCatAvatar } from '../shell/ShellCatAvatar';
import { ShellGlyph } from '../shell/ShellIcons';
import { useShellCopy } from '../shell/shell-copy';
import { artifactObjectId } from '../workbench/real-surface-adapters';
import { newConversationCopy } from './new-conversation.shell-copy';
import { projectRecentWorks } from './recent-works';

export function RecentWorks({
  onOpen,
  onOpenAll,
  onDiscuss,
  ownerUserId,
}: {
  onOpen: (artifact: GlobalArtifactDTO) => void;
  onOpenAll: () => void;
  onDiscuss?: (artifact: GlobalArtifactDTO) => void;
  ownerUserId?: string | null;
}) {
  const t = useShellCopy(newConversationCopy);
  const { getCatById } = useCatData();
  // Keep the existing cheap owner-global landing read. A person scrolling further requests the existing complete Works catalogue once.
  const recent = useGlobalArtifacts(ownerUserId !== null, { view: 'recent-works', limit: 12 }, ownerUserId);
  const [expansion, setExpansion] = useState({ ownerUserId, expanded: false });
  const expanded = expansion.ownerUserId === ownerUserId && expansion.expanded;
  const all = useGlobalArtifacts(expanded && ownerUserId !== null, { view: 'works' }, ownerUserId);
  const useAll = expanded && !all.loading && all.complete && all.workLineage === 'resolved';
  const source = useAll ? all : recent;
  const lineage = source.workLineage;
  const works = useMemo(
    () => projectRecentWorks(source.artifacts, lineage, Number.POSITIVE_INFINITY),
    [source.artifacts, lineage],
  );
  const progressive = useProgressiveWorks(works.length, JSON.stringify(['recent-works', ownerUserId]));
  const executions = useActiveExecutionStore((state) => state.executionsByKey);
  const running = useMemo(
    () => new Set(Object.values(executions).map((item) => JSON.stringify([item.threadId, item.catId]))),
    [executions],
  );
  const failed = (source.error || !source.complete) && works.length === 0;
  const waitingForWorks = (source.loading || (expanded && (all.loading || all.loadingMore))) && works.length === 0;
  const complete = useAll && all.complete && all.workLineage === 'resolved';
  const more = progressive.more || !expanded;
  const loadMore = useCallback(() => {
    if (!expanded) setExpansion({ ownerUserId, expanded: true });
    else progressive.loadMore();
  }, [expanded, progressive.loadMore, ownerUserId]);
  // The same sentinel admits the original complete read, then reveals batches from that source without a cap.
  const { sentinel } = useRecentCatalogueSentinel(
    expanded && more && works.length > 0 && !source.loading && !all.error && !all.loading && all.complete,
    loadMore,
  );
  return (
    <section className="recent-works-gallery" aria-labelledby="recent-works-heading" data-testid="recent-works">
      <div className="mb-3 flex items-center gap-3 px-0.5 text-xs text-[var(--shell-muted)]">
        <h2 id="recent-works-heading" className="font-normal">
          {t.recentWorks}
        </h2>
        <button
          type="button"
          className="shell-focusable ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:text-[var(--shell-ink)]"
          onClick={onOpenAll}
        >
          {t.allWorks}
          <ShellGlyph name="chevronRight" className="h-3 w-3" />
        </button>
      </div>
      {!source.loading && !source.complete && works.length > 0 && (
        <p className="mb-3 text-xs text-[var(--shell-muted)]">{t.partialWorks}</p>
      )}
      {waitingForWorks && <output aria-busy="true">{t.loadingWorks}</output>}
      {!waitingForWorks && failed && (
        <div role="alert">
          <span>{t.worksFailed}</span>
          <button type="button" className="shell-focusable" onClick={source.refetch}>
            {t.retry}
          </button>
        </div>
      )}
      {!waitingForWorks && !failed && works.length === 0 && <p>{t.noWorks}</p>}
      {!waitingForWorks && !failed && works.length > 0 && (
        <>
          <div className="recent-works-grid">
            {works.slice(0, progressive.limit).map((artifact) => {
              const catName =
                artifact.catId && getCatById(artifact.catId)
                  ? resolveCatNameplateName(artifact.catId, getCatById)
                  : t.unknownCat;
              const active = running.has(JSON.stringify([artifact.threadId, artifact.catId]));
              const time = formatRecentWorkTime(artifact.createdAt, t);
              return (
                <WorkGalleryCard
                  key={JSON.stringify([artifact.threadId, artifactObjectId(artifact)])}
                  artifact={artifact}
                  testId="recent-work-card"
                  subtitle={
                    <span className="recent-work-context">
                      <span className="recent-work-conversation" title={t.workConversation(artifact.threadTitle)}>
                        {t.workConversation(artifact.threadTitle)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="recent-work-time">
                        {active ? (
                          <>
                            <span className="home-dot" data-tone="live" aria-hidden="true" />
                            {t.working}
                          </>
                        ) : (
                          time
                        )}
                      </span>
                    </span>
                  }
                  onSelect={() => onOpen(artifact)}
                  footer={
                    <>
                      <span className="recent-work-author" title={catName}>
                        {artifact.catId && <ShellCatAvatar catId={artifact.catId} size={18} />}
                        <span>{catName}</span>
                      </span>
                      <button
                        type="button"
                        className="recent-work-chat shell-focusable"
                        disabled={!onDiscuss || !artifact.catId || !artifact.sourceMessageId}
                        onClick={() => onDiscuss?.(artifact)}
                      >
                        {t.goChat} ›
                      </button>
                    </>
                  }
                />
              );
            })}
          </div>
          {more || !complete ? (
            <button
              ref={sentinel}
              type="button"
              className="work-gallery-more shell-focusable"
              disabled={all.loading || all.loadingMore}
              onClick={all.error || (expanded && !more) ? all.refetch : loadMore}
            >
              {all.loading || all.loadingMore
                ? t.loadingWorks
                : all.error || (expanded && !more && !complete)
                  ? t.moreWorksFailed
                  : t.moreWorks}
            </button>
          ) : (
            <p className="recent-works-end">
              {t.allWorksShown} ·{' '}
              <button type="button" className="shell-focusable" onClick={onOpenAll}>
                {t.allWorks} ›
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function formatRecentWorkTime(createdAt: number, t: typeof newConversationCopy.zh): string {
  const minutes = Math.floor((Date.now() - createdAt) / 60_000);
  if (minutes < 1) return t.justNow;
  if (minutes < 60) return t.minutesAgo(minutes);
  if (minutes < 1440) return t.hoursAgo(Math.floor(minutes / 60));
  return t.daysAgo(Math.floor(minutes / 1440));
}

function useRecentCatalogueSentinel(enabled: boolean, load: () => void) {
  const sentinel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!enabled || !sentinel.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
      },
      { rootMargin: '240px' },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [enabled, load]);
  return { sentinel };
}
