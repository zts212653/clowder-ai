import type { ListenDocumentCacheProjection } from '@/stores/listenModeStore';
import { useShellCopy } from '../shell/shell-copy';
import { useShellPresentation } from '../shell/shell-presentation';
import { WorkspaceToolbarButton as ToolbarBtn } from './WorkspaceToolbarButton';
import { workspaceFileCopy } from './workspace-file.shell-copy';

const PlayIcon = () => (
  <svg aria-hidden="true" className="h-3 w-3" viewBox="0 0 12 14" fill="currentColor">
    <path d="M1 1l10 6-10 6V1z" />
  </svg>
);

interface WorkspaceListenActionsProps {
  active: boolean;
  cache: Pick<ListenDocumentCacheProjection, 'active' | 'cachedAnchors' | 'error' | 'totalSentences'>;
  hasSentences: boolean;
  onCancelCache: () => void;
  onStartCache: () => void;
  onStartListen: () => void;
  action?: 'listen' | 'cache';
  listenLabel?: string;
}

function cacheActionText(cache: WorkspaceListenActionsProps['cache'], t: typeof workspaceFileCopy.zh): string {
  const cached = cache.cachedAnchors.length;
  const total = cache.totalSentences;
  if (cache.active) return t.cache(cached, total);
  if (cached > 0 && cached < total) return t.resumeCache(cached, total);
  if (total > 0 && cached === total) return t.cache(cached, total);
  return t.cacheAll;
}

export function WorkspaceListenActions({
  active,
  cache,
  hasSentences,
  onCancelCache,
  onStartCache,
  onStartListen,
  action,
  listenLabel,
}: WorkspaceListenActionsProps) {
  const localized = useShellCopy(workspaceFileCopy);
  const isV2 = useShellPresentation() === 'v2';
  const t = isV2 ? localized : workspaceFileCopy.zh;
  const cached = cache.cachedAnchors.length;
  const complete = cache.totalSentences > 0 && cached === cache.totalSentences;
  const cacheTitle = cache.active
    ? t.caching(cached, cache.totalSentences)
    : cache.error
      ? t.cacheFailed(cache.error)
      : complete
        ? t.cachedAll
        : cached > 0
          ? t.cacheProgress(cached, cache.totalSentences)
          : t.cacheTitle;

  return (
    <>
      {action !== 'cache' && (
        <ToolbarBtn
          active={active}
          activeClass="bg-cafe-accent text-[var(--cafe-accent-foreground)] hover:bg-cafe-interactive"
          onClick={onStartListen}
          title={hasSentences ? t.listenTitle : t.noSentences}
          disabled={!hasSentences}
        >
          <span className="inline-flex items-center gap-1">
            <PlayIcon />
            {isV2 ? t.listen : (listenLabel ?? t.listen)}
          </span>
        </ToolbarBtn>
      )}
      {action !== 'listen' && (
        <ToolbarBtn
          active={cache.active}
          activeClass="bg-cafe-interactive text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent"
          onClick={cache.active ? onCancelCache : onStartCache}
          title={cacheTitle}
          disabled={!hasSentences || (complete && !cache.active)}
        >
          {cacheActionText(cache, t)}
        </ToolbarBtn>
      )}
    </>
  );
}
