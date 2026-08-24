import type { ListenDocumentCacheProjection } from '@/stores/listenModeStore';
import { WorkspaceToolbarButton as ToolbarBtn } from './WorkspaceToolbarButton';

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
}

function cacheActionText(cache: WorkspaceListenActionsProps['cache']): string {
  const cached = cache.cachedAnchors.length;
  const total = cache.totalSentences;
  if (cache.active) return `缓存 ${cached}/${total}`;
  if (cached > 0 && cached < total) return `继续缓存 ${cached}/${total}`;
  if (total > 0 && cached === total) return `缓存 ${cached}/${total}`;
  return '缓存全文';
}

export function WorkspaceListenActions({
  active,
  cache,
  hasSentences,
  onCancelCache,
  onStartCache,
  onStartListen,
}: WorkspaceListenActionsProps) {
  const cached = cache.cachedAnchors.length;
  const complete = cache.totalSentences > 0 && cached === cache.totalSentences;
  const cacheTitle = cache.active
    ? `正在缓存 ${cached}/${cache.totalSentences} 句；点击取消缓存`
    : cache.error
      ? `${cache.error}；点击继续缓存`
      : complete
        ? '此文档已缓存全文'
        : cached > 0
          ? `从真实缓存进度继续：${cached}/${cache.totalSentences} 句`
          : '缓存全文，稍后可直接听读';

  return (
    <>
      <ToolbarBtn
        active={active}
        activeClass="bg-cafe-accent text-[var(--cafe-accent-foreground)] hover:bg-cafe-interactive"
        onClick={onStartListen}
        title={hasSentences ? '从上次位置开始听读' : '这份 Markdown 没有可听正文'}
        disabled={!hasSentences}
      >
        <span className="inline-flex items-center gap-1">
          <PlayIcon />
          听读
        </span>
      </ToolbarBtn>
      <ToolbarBtn
        active={cache.active}
        activeClass="bg-cafe-interactive text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent"
        onClick={cache.active ? onCancelCache : onStartCache}
        title={cacheTitle}
        disabled={!hasSentences || (complete && !cache.active)}
      >
        {cacheActionText(cache)}
      </ToolbarBtn>
    </>
  );
}
