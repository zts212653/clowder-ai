'use client';

import { type GlobalArtifactDTO, projectThreadWorks, type ThreadArtifactDTO } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useArtworkLightboxScope } from '@/components/content-review/ArtworkLightboxScope';
import { useArtifactLightbox } from '@/components/content-review/useArtifactLightbox';
import { useShellCopy } from '@/components/shell/shell-copy';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { artifactObjectId } from '@/components/workbench/real-surface-adapters';
import { artifactCardMetadata } from '@/components/workspace-home/artifact-card-metadata';
import { HomeArtifactLightbox } from '@/components/workspace-home/HomeArtifactLightbox';
import { workspaceV3Copy } from '@/components/workspace-home/workspace-v3.shell-copy';
import { useCatData } from '@/hooks/useCatData';
import { useGlobalArtifacts } from '@/hooks/useGlobalArtifacts';
import { useThreadArtifacts } from '@/hooks/useThreadArtifacts';
import { resolveCatNameplateName } from '@/lib/cat-display-name';
import { useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import type { GroupingMode } from './artifact-grouping';
import type { ArtifactListOrigin, ArtifactListView } from './artifact-list-state';
import { useProgressiveWorks } from './useProgressiveWorks';
import { useWorksViewportReturn } from './useWorksViewportReturn';
import { WorkGalleryCard } from './WorkGalleryCard';
import { worksPanelCopy } from './works-panel.shell-copy';
import '../workspace-home/workspace-v3.css';

export type WorksPanelProps = {
  threadId: string;
  width?: number;
  onClose?: () => void;
  onSelectArtifact?: (artifact: ThreadArtifactDTO | GlobalArtifactDTO, origin: ArtifactListOrigin) => void;
  initialView?: ArtifactListView;
};
type Work = ThreadArtifactDTO | GlobalArtifactDTO;
type Filter = ArtifactListView['filter'];
const sourceThread = (artifact: Work, host: string) => ('threadId' in artifact ? artifact.threadId : host);
const matches = (artifact: Work, filter: Filter) =>
  filter === 'all' ||
  (filter === 'codepr' ? artifact.type === 'code' || artifact.type === 'pr' : artifact.type === filter);

/** The existing artifact-list owner and origin schema, with the original content open callback. */
export function ThreadWorksPanelV2({ threadId, width, onClose, onSelectArtifact, initialView }: WorksPanelProps) {
  const t = useShellCopy(worksPanelCopy);
  const floating = useArtifactLightbox(threadId);
  const floatingScope = useArtworkLightboxScope();
  const cardCopy = useShellCopy(workspaceV3Copy);
  const { getCatById } = useCatData();
  const [scope, setScope] = useState(initialView?.scope ?? (threadId === 'default' ? 'global' : 'thread'));
  const [filter, setFilter] = useState<Filter>(initialView?.filter ?? 'all');
  const [query, setQuery] = useState(initialView?.query ?? '');
  const grouping: GroupingMode = initialView?.grouping ?? 'time';
  const [catFilter, setCatFilter] = useState<string | null>(initialView?.catFilter ?? null);
  const collapsed = initialView?.collapsed ?? [];
  const [selected, setSelected] = useState<Work | null>(null);
  const [notice, setNotice] = useState<string | undefined>();
  const previewOrigin = useRef<HTMLButtonElement | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const thread = useThreadArtifacts(threadId === 'default' ? undefined : threadId, 'works');
  const global = useGlobalArtifacts(scope === 'global', { view: 'works' });
  const active = scope === 'global' ? global : thread;
  const globalWorks = useMemo(
    () => projectThreadWorks(global.artifacts, global.workLineage === 'resolved'),
    [global.artifacts, global.workLineage],
  );
  const works: Work[] = scope === 'global' ? globalWorks : thread.works;
  const complete = active.complete && (scope !== 'global' || global.workLineage === 'resolved');
  const author = (id: string | null) => {
    const cat = id ? getCatById(id) : undefined;
    return id && cat ? resolveCatNameplateName(id, getCatById) : cardCopy.unknownAuthor;
  };
  const meta = (artifact: Work) => artifactCardMetadata(artifact, author(artifact.catId), cardCopy);
  const workKey = (artifact: ThreadArtifactDTO) =>
    JSON.stringify(['threadId' in artifact ? artifact.threadId : threadId, artifactObjectId(artifact)]);
  const byAuthor =
    scope === 'global' && catFilter !== null ? works.filter((item) => (item.catId ?? '—') === catFilter) : works;
  useEffect(() => {
    if (
      (scope !== 'global' || complete) &&
      !active.loading &&
      !active.error &&
      filter !== 'all' &&
      !byAuthor.some((item) => matches(item, filter))
    ) {
      setFilter('all');
    }
  }, [scope, complete, active.loading, active.error, filter, byAuthor]);
  const visible = byAuthor.filter(
    (item) => matches(item, filter) && item.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const required = initialView?.viewport?.anchor
    ? visible.findIndex((artifact) => workKey(artifact) === initialView.viewport?.anchor?.key) + 1
    : initialView?.viewport
      ? visible.length
      : 0;
  const progressive = useProgressiveWorks(
    visible.length,
    JSON.stringify([threadId, scope, query, filter, catFilter]),
    scroll,
    required,
  );
  useWorksViewportReturn(scroll, initialView?.viewport, !active.loading && !active.error);
  const close = useCallback(() => {
    const ownsFocus = document.activeElement?.closest('.home-lightbox');
    setSelected(null);
    if (ownsFocus && previewOrigin.current?.isConnected) previewOrigin.current.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    setSelected(null);
    setNotice(undefined);
  }, [threadId, scope]);
  const open = (artifact: Work) => {
    const list = scroll.current;
    const card =
      list &&
      [...list.querySelectorAll<HTMLElement>('[data-work-anchor]')].find(
        (node) => node.dataset.workAnchor === workKey(artifact),
      );
    const origin: ArtifactListOrigin = {
      kind: 'artifact-list',
      threadId,
      view: {
        scope,
        filter,
        query,
        grouping,
        catFilter,
        collapsed: [...collapsed],
        ...(list
          ? {
              viewport: {
                scrollTop: Math.max(0, list.scrollTop),
                ...(card
                  ? {
                      anchor: {
                        key: workKey(artifact),
                        offset: card.getBoundingClientRect().top - list.getBoundingClientRect().top,
                      },
                    }
                  : {}),
              },
            }
          : {}),
      },
    };
    const openWorkspace = () => {
      if (onSelectArtifact) onSelectArtifact(artifact, origin);
      else useChatStore.getState().openPublishedArtifact(threadId, artifact, origin);
    };
    if (!floating.open(artifact, origin)) openWorkspace();
  };
  const jump = (artifact: Work) => {
    if (!artifact.sourceMessageId) {
      setNotice(cardCopy.unavailable);
      return;
    }
    const chat = useChatStore.getState();
    const plan = planTeleport({
      threadId: sourceThread(artifact, threadId),
      messageId: artifact.sourceMessageId,
      currentThreadId: chat.currentThreadId,
    });
    if (plan.navigateTo) pushThreadRouteWithHistory(plan.navigateTo, window);
    else if (plan.scrollNow) {
      scrollToMessage(plan.scrollNow);
      kickTeleportResolve();
    }
    chat.closeRightPanel();
  };
  const select = (artifact: Work) => {
    setNotice(undefined);
    if (floatingScope && (artifact.type === 'image' || artifact.type === 'video') && artifact.url) open(artifact);
    else if (artifact.type === 'image' && artifact.url) setSelected(artifact);
    // 有精确坐标的 HTML 原块在 Works 内直接预览；interactive 卡片和旧数据没有坐标，
    // 仍回原消息处理（审批/选择必须在聊天里承载）。
    else if (artifact.type === 'widget' && !(artifact.sourceMessageId && artifact.widgetBlockId)) jump(artifact);
    else open(artifact);
  };
  const image = selected && active.artifacts.find((item) => workKey(item) === workKey(selected));
  return (
    <section
      className="v2-works-panel"
      data-testid="v2-works-panel"
      style={width ? { width, flexShrink: 0 } : undefined}
    >
      <header className="v2-works-header">
        <div className="v2-works-topline">
          <h2 className="text-sm font-semibold">{t.title}</h2>
          <span className="v2-works-count text-xs text-cafe-muted">
            {active.loading && !complete
              ? cardCopy.worksLoading
              : active.error && works.length === 0
                ? cardCopy.worksUnavailable
                : complete
                  ? `${t.total(works.length)} · ${t.latest}`
                  : t.incomplete}
          </span>
          <div className="v2-works-scope" role="group" aria-label={t.title}>
            {(['thread', 'global'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="shell-focusable"
                aria-pressed={scope === value}
                disabled={value === 'thread' && threadId === 'default'}
                onClick={() => {
                  setScope(value);
                  setFilter('all');
                  setQuery('');
                  setCatFilter(null);
                }}
              >
                {value === 'thread' ? t.thread : t.global}
              </button>
            ))}
          </div>
          {onClose && (
            <button type="button" className="shell-focusable" aria-label={t.close} onClick={onClose}>
              ×
            </button>
          )}
        </div>
        <div className="v2-works-tools">
          <input
            value={query}
            aria-label={t.search}
            placeholder={t.search}
            onChange={(event) => setQuery(event.target.value)}
            className="v2-works-search shell-focusable"
          />
          <select
            aria-label={t.type}
            value={filter}
            className="v2-works-type shell-focusable"
            onChange={(event) => setFilter(event.target.value as Filter)}
          >
            <option value="all">{t.allTypes}</option>
            {(Object.keys(t.filters) as Filter[])
              .filter((value) => value !== 'all')
              .map((value) => {
                const count = byAuthor.filter((item) => matches(item, value)).length;
                return count ? (
                  <option key={value} value={value}>
                    {t.filters[value]} · {count}
                  </option>
                ) : null;
              })}
          </select>
        </div>
        {active.error && (
          <button className="home-btn shell-focusable" type="button" onClick={active.refetch}>
            {t.retry}
          </button>
        )}
        {notice && <output className="text-xs">{notice}</output>}
      </header>
      <div ref={scroll} className="v2-works-scroll">
        {floating.error && <p role="alert">{floating.error}</p>}
        {!active.loading && !active.error && complete && !visible.length && <p className="text-xs">{t.empty}</p>}
        {!active.loading && (!active.error || works.length > 0) && (
          <>
            <div className="v2-works-grid">
              {visible.slice(0, progressive.limit).map((artifact) => (
                <div key={workKey(artifact)} data-work-anchor={workKey(artifact)}>
                  <WorkGalleryCard
                    artifact={artifact}
                    metadata={meta(artifact)}
                    onSelect={(card) => {
                      previewOrigin.current = card;
                      select(artifact);
                    }}
                    onOpenSource={artifact.sourceMessageId ? () => jump(artifact) : undefined}
                    sourceLabel={t.original}
                  />
                </div>
              ))}
            </div>
            {progressive.more && (
              <button
                ref={progressive.sentinel}
                type="button"
                className="work-gallery-more shell-focusable"
                onClick={progressive.loadMore}
              >
                {t.loadMore}
              </button>
            )}
          </>
        )}
      </div>
      {image && (
        <HomeArtifactLightbox
          artifact={image}
          images={visible.filter((item) => item.type === 'image' && !!item.url)}
          onSelect={setSelected}
          onClose={close}
          onAnnotate={() => {
            open(image);
            close();
          }}
          metadata={meta(image)}
          notice={notice}
          artifactKey={workKey}
        />
      )}
    </section>
  );
}
