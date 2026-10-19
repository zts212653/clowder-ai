import { useEffect, useRef } from 'react';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { SharedArtifactCard } from './SharedArtifactCard.js';

export { SharedArtifactCard } from './SharedArtifactCard.js';

import { SharedArtifactLibraryFilters, useArtifactLibraryFilters } from './SharedArtifactLibraryFilters.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

export function SharedArtifactCards({ eventId }: { readonly eventId: string }) {
  const shared = useSharedArtifacts();
  if (shared?.status !== 'ready') return null;
  return (
    <>
      {shared.catalogue
        .filter((item) => item.sourceEventId === eventId)
        .map((item) => (
          <SharedArtifactCard key={item.artifactId} artifact={item} />
        ))}
    </>
  );
}
export function SharedArtifactLibrary({
  channelId,
  title = '共同作品',
  active = true,
  filterable = false,
  onOpenNavigation,
  presentation = 'gallery',
  onOpenChannelLibrary,
  requestedChannel,
}: {
  readonly channelId?: string;
  readonly title?: string;
  readonly active?: boolean;
  readonly filterable?: boolean;
  readonly onOpenNavigation?: () => void;
  readonly presentation?: 'gallery' | 'channel';
  readonly onOpenChannelLibrary?: () => void;
  readonly requestedChannel?: { channelId: string; revision: number };
}) {
  const shared = useSharedArtifacts();
  const model = useArtifactLibraryFilters(shared?.catalogue ?? [], channelId, requestedChannel);
  const t = useCollectiveText();
  const scroll = useRef<HTMLElement>(null);
  const workUnit = useWorkUnit();
  const position = useRef(0);
  useEffect(() => {
    if (active && scroll.current) scroll.current.scrollTop = position.current;
  }, [active]);
  if (!shared) return null;
  // Retain filters and the return position without duplicating the channel's cards or controls in the DOM.
  if (!active) return <section ref={scroll} hidden className="shared-artifact-library" aria-label={title} />;
  if (presentation === 'channel')
    return (
      <section className="channel-artifact-list" aria-label={t('频道作品')}>
        <p className="channel-artifact-heading">
          {model.channelWorks.length} {workUnit(model.channelWorks.length)} · #{channelId}
        </p>
        <SharedArtifactLibraryContents model={model} filterable={false} />
        {onOpenChannelLibrary && (
          <button type="button" className="channel-artifact-all" onClick={onOpenChannelLibrary}>
            {t('在全部作品中查看本频道')} →
          </button>
        )}
      </section>
    );
  return (
    <section
      ref={scroll}
      hidden={!active}
      onScroll={(event) => {
        if (active) position.current = event.currentTarget.scrollTop;
      }}
      className="shared-artifact-library"
      aria-label={title}
    >
      <header>
        {onOpenNavigation && (
          <button type="button" className="mobile-navigation" aria-label={t('频道导航')} onClick={onOpenNavigation}>
            ☰
          </button>
        )}
        <h2>
          {t(title)}{' '}
          <small>
            {model.channelWorks.length} {workUnit(model.channelWorks.length)} · {t('最新在前')}
          </small>
        </h2>
      </header>
      {filterable && <SharedArtifactLibraryFilters model={model} channelId={channelId} />}
      <SharedArtifactLibraryContents model={model} filterable={filterable} />
    </section>
  );
}

function SharedArtifactLibraryContents({
  model,
  filterable,
}: {
  readonly model: ReturnType<typeof useArtifactLibraryFilters>;
  readonly filterable: boolean;
}) {
  const shared = useSharedArtifacts();
  const t = useCollectiveText();
  const workUnit = useWorkUnit();
  const filtered = Boolean(model.filters.query.trim() || model.filters.channel || model.filters.media !== 'all');
  if (!shared) return null;
  if (shared.status === 'loading') return <output>{t('正在读取作品…')}</output>;
  if (shared.status !== 'ready')
    return (
      <div role="alert">
        <p>{t(shared.status === 'access_denied' ? '你已无法查看这里的作品。' : '暂时读不到作品，请稍后重试。')}</p>
        <button type="button" onClick={() => void shared.refresh()}>
          {t('重新读取')}
        </button>
      </div>
    );
  if (model.artifacts.length)
    return (
      <>
        {filterable && filtered && (
          <output className="shared-artifact-library-count">
            {t('找到')} {model.artifacts.length} {workUnit(model.artifacts.length)}
          </output>
        )}
        <div className="shared-artifact-grid">
          {model.artifacts.map((item) => (
            <SharedArtifactCard key={item.artifactId} artifact={item} presentation={filterable ? 'tile' : 'row'} />
          ))}
        </div>
      </>
    );
  if (model.channelWorks.length)
    return (
      <div className="channel-empty">
        <h3>{t('没有匹配的作品')}</h3>
        <button type="button" onClick={model.clear}>
          {t('清除作品筛选')}
        </button>
      </div>
    );
  return (
    <div className="channel-empty">
      <h3>{t('还没有共同作品')}</h3>
      <p>{t('在一条讨论消息的「更多」里分享作品，作品和来源会一起留在这里。')}</p>
    </div>
  );
}

function useWorkUnit() {
  const language = useCollectiveLanguage();
  return (count: number) => (language === 'en' ? (count === 1 ? 'work' : 'works') : '件作品');
}
