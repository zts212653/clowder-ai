import { HeaderFrame, ShellGlyph, WorksIcon } from '@cat-cafe/ui';
import type { MouseEvent } from 'react';
import { useCollectiveText } from './collective-copy.js';

export function ChannelHeader({
  collectiveName,
  channelId,
  searchCount,
  connection,
  onOpenNavigation,
  onChannelCafe,
  destinationTitle,
  memberCount,
  artifactCount,
  workCount,
  onMembers,
  onArtifacts,
  onWorks,
  onSearch,
  activePanel,
}: {
  readonly destinationTitle?: string;
  readonly collectiveName: string;
  readonly channelId: string;
  readonly searchCount?: number;
  readonly connection: 'online' | 'offline';
  readonly onOpenNavigation: () => void;
  readonly onCafe?: () => void;
  readonly onChannelCafe?: () => void;
  readonly guideCatCount?: number;
  readonly memberCount?: number;
  readonly artifactCount?: number;
  readonly workCount?: number;
  readonly onMembers?: () => void;
  readonly onArtifacts?: () => void;
  readonly onWorks?: () => void;
  readonly onSearch?: () => void;
  readonly activePanel?: string;
}) {
  const t = useCollectiveText();
  const openChannelCafe = (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest('details')?.removeAttribute('open');
    onChannelCafe?.();
  };
  return (
    <HeaderFrame className="scene-header">
      <button type="button" className="mobile-navigation" aria-label={t('频道导航')} onClick={onOpenNavigation}>
        <ShellGlyph name="panelLeft" />
      </button>
      <div className="channel-heading">
        {destinationTitle ? (
          <h1>{destinationTitle}</h1>
        ) : searchCount !== undefined ? (
          <h1>搜索结果 · {searchCount}</h1>
        ) : (
          <details className="channel-menu">
            <summary>
              <h1># {channelId}</h1>
              <ShellGlyph name="chevronDown" />
            </summary>
            <div className="channel-menu-popover">
              <span>
                {collectiveName} · # {channelId}
              </span>
              {onChannelCafe && (
                <button type="button" onClick={openChannelCafe}>
                  {t('谁留意频道消息…')} <small>{t('仅自己可见')}</small>
                </button>
              )}
            </div>
          </details>
        )}
      </div>
      <div className="scene-header-actions">
        {connection === 'offline' && <span className="offline-label">{t('暂时离线')}</span>}
        {onMembers && (
          <button type="button" onClick={onMembers} aria-label={t('查看成员')}>
            <ShellGlyph name="users" />
            <span>{memberCount === undefined ? t('成员') : `${memberCount} ${t('成员')}`}</span>
          </button>
        )}
        {onArtifacts && (
          <button
            type="button"
            onClick={onArtifacts}
            aria-label={t('频道作品')}
            aria-pressed={activePanel === 'artifacts'}
          >
            <WorksIcon />
            <span>
              {t('作品')}
              {artifactCount === undefined ? '' : ` ${artifactCount}`}
            </span>
          </button>
        )}
        {onWorks && (
          <button
            type="button"
            onClick={onWorks}
            aria-label={`${t('任务')}${workCount === undefined ? '' : ` ${workCount}`}`}
            aria-pressed={activePanel === 'works'}
          >
            <ShellGlyph name="checkSquare" />
            <span>
              {t('任务')}
              {workCount === undefined ? '' : ` ${workCount}`}
            </span>
          </button>
        )}
        {onSearch && (
          <button type="button" aria-label={t('搜索频道与话题')} onClick={onSearch}>
            <ShellGlyph name="search" />
          </button>
        )}
      </div>
    </HeaderFrame>
  );
}
