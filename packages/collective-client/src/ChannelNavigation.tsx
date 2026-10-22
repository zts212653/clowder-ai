import { AppTooltip, ShellGlyph, WorksIcon } from '@cat-cafe/ui';
import { useEffect, useRef, useState } from 'react';
import { CollectiveIcon } from './CollectiveIcon.js';
import type { channelDestinations } from './channel-navigation.js';
import { useCollectiveText } from './collective-copy.js';

export function ChannelNavigation({
  channels,
  channelId,
  query,
  onQuery,
  onSelect,
  onMembers,
  onLibrary,
  libraryActive,
  onRoadmap,
  roadmapActive,
  roadmapCount,
  memberCount,
}: {
  readonly channels: ReturnType<typeof channelDestinations>;
  readonly channelId?: string;
  readonly query: string;
  readonly onQuery: (value: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onMembers: () => void;
  readonly onLibrary?: () => void;
  readonly libraryActive?: boolean;
  readonly guideCatCount?: number;
  readonly onRoadmap?: () => void;
  readonly roadmapActive?: boolean;
  readonly roadmapCount?: number;
  readonly memberCount?: number;
}) {
  const t = useCollectiveText();
  const [searchOpen, setSearchOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (searchOpen) search.current?.focus();
  }, [searchOpen]);
  const visible = channels.filter((channel) =>
    channel.id.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <>
      <div className="destination-search" data-open={searchOpen || Boolean(query)}>
        <AppTooltip label={t('搜索频道与话题')}>
          <button
            type="button"
            className="destination-search-trigger"
            ref={trigger}
            aria-label={t('搜索频道与话题')}
            onClick={() => setSearchOpen((value) => !value)}
          >
            <CollectiveIcon kind="search" />
          </button>
        </AppTooltip>
        <label className="destination-search-field">
          <input
            type="search"
            ref={search}
            tabIndex={searchOpen || query ? 0 : -1}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearchOpen(false);
                onQuery('');
                trigger.current?.focus();
              }
            }}
            aria-label={t('搜索频道与话题')}
            placeholder={t('搜索频道、话题或消息')}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="destination-scroll">
        <div className="destination-global-entries">
          {onRoadmap && (
            <nav className="destination-list destination-global-list" aria-label={t('项目')}>
              <button
                type="button"
                aria-label={t('项目')}
                className={`destination-item ${roadmapActive ? 'destination-item-active' : ''}`}
                aria-current={roadmapActive ? 'page' : undefined}
                onClick={onRoadmap}
              >
                <span className="destination-symbol">
                  <ShellGlyph name="checkSquare" />
                </span>
                <span>
                  <strong>{t('项目')}</strong>
                </span>
                {roadmapCount !== undefined && <small>{roadmapCount}</small>}
              </button>
            </nav>
          )}
          {onLibrary && (
            <nav className="destination-list destination-global-list" aria-label={t('作品资料库')}>
              <button
                type="button"
                aria-label={t('全部作品')}
                className={`destination-item ${libraryActive ? 'destination-item-active' : ''}`}
                aria-current={libraryActive ? 'page' : undefined}
                onClick={onLibrary}
              >
                <span className="destination-symbol" aria-hidden="true">
                  <WorksIcon />
                </span>
                <span>
                  <strong>{t('全部作品')}</strong>
                </span>
              </button>
            </nav>
          )}
          <nav className="destination-list destination-global-list member-destination" aria-label={t('共同家园成员')}>
            <button type="button" className="destination-item" onClick={onMembers}>
              <span className="destination-symbol">
                <CollectiveIcon kind="members" />
              </span>
              <span>
                <strong>{t('成员')}</strong>
              </span>
              {memberCount !== undefined && <small>{memberCount}</small>}
            </button>
          </nav>
        </div>
        <nav className="destination-list" aria-label={t('频道')}>
          <p>
            {t('频道')} {channels.length}
          </p>
          {(query ? visible : channels).map((channel) => (
            <button
              key={channel.id}
              type="button"
              className={`destination-item channel-destination ${channel.id === channelId ? 'destination-item-active' : ''}`}
              aria-current={channel.id === channelId ? 'page' : undefined}
              onClick={() => onSelect(channel.id)}
            >
              <span className="destination-symbol">#</span>
              <span>
                <strong>{channel.id}</strong>
              </span>
            </button>
          ))}
          {query && !visible.length && <p className="navigation-empty">{t('没有同名频道；主区显示匹配的消息。')}</p>}
        </nav>
      </div>
    </>
  );
}
