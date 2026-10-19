import type { MouseEvent, ReactNode } from 'react';
import { CollectiveWorldRail } from './CollectiveWorldRail.js';
import type { CollectiveMembership } from './client-types.js';
import { useCollectiveText } from './collective-copy.js';

function DestinationTitle({
  collective,
  onHome,
  meta,
  canSteward,
  canLeave,
  onInvite,
  onCafe,
  onReplayGuide,
  onPermissions,
  onCalendar,
  onReconnect,
  onLeave,
}: {
  readonly collective?: CollectiveMembership;
  readonly onHome?: () => void;
  readonly meta?: ReactNode;
  readonly canSteward: boolean;
  readonly canLeave: boolean;
  readonly onInvite: () => void;
  readonly onCafe?: () => void;
  readonly onReplayGuide?: () => void;
  readonly onPermissions?: () => void;
  readonly onCalendar?: () => void;
  readonly onReconnect?: () => void;
  readonly onLeave?: () => void;
}) {
  const t = useCollectiveText();
  if (!collective) return <h1>{t('共同家园')}</h1>;
  const hasMenu = Boolean(onHome || canSteward || onCafe || onReplayGuide || (canLeave && onLeave));
  if (!hasMenu) return <h1>{collective.name}</h1>;
  const action = (callback: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest('details')?.removeAttribute('open');
    callback();
  };
  return (
    <details className="collective-menu">
      <summary aria-label={`${collective.name}菜单`}>
        <h1>{collective.name}</h1>
        <span aria-hidden="true">⌄</span>
      </summary>
      <div className="collective-menu-popover">
        <button
          type="button"
          className="collective-menu-heading"
          aria-label={onHome ? `打开${collective.name}首页` : undefined}
          onClick={onHome ? action(onHome) : undefined}
        >
          <strong>{collective.name}</strong>
          {meta && <span>{meta}</span>}
        </button>
        {canSteward && (
          <button type="button" onClick={action(onInvite)}>
            {t('邀请成员')}
          </button>
        )}
        {onCafe && (
          <button type="button" onClick={action(onCafe)}>
            {t('我的猫…')} <small>{t('仅自己可见')}</small>
          </button>
        )}
        {onPermissions && (
          <button type="button" onClick={action(onPermissions)}>
            {t('已允许的任务…')}
          </button>
        )}
        {onCalendar && (
          <button type="button" onClick={action(onCalendar)}>
            {t('我的日程…')}
          </button>
        )}
        {onReconnect && (
          <button type="button" onClick={action(onReconnect)}>
            {t('重新连接…')}
          </button>
        )}
        {onReplayGuide && (
          <button type="button" onClick={action(onReplayGuide)}>
            {t('再看一遍介绍')}
          </button>
        )}
        {canLeave && onLeave && (
          <button type="button" className="collective-menu-muted" onClick={action(onLeave)}>
            {t('离开共同体…')}
          </button>
        )}
      </div>
    </details>
  );
}

export function ProductShell({
  embedded,
  collective,
  collectives,
  onSelectCollective,
  onHome,
  connection,
  canSteward,
  canPair,
  pairNudge = false,
  canLeave = false,
  notice,
  onInvite,
  onPair,
  onLeave,
  onCafe,
  onReplayGuide,
  onPermissions,
  onCalendar,
  onReconnect,
  destinations,
  headerMeta,
  children,
  navigationOpen = false,
  onCloseNavigation,
}: {
  readonly embedded: boolean;
  readonly collective?: CollectiveMembership;
  readonly collectives?: readonly CollectiveMembership[];
  readonly onSelectCollective?: (collectiveId: string) => void;
  readonly onHome?: () => void;
  readonly connection: 'online' | 'offline';
  readonly canSteward: boolean;
  readonly canPair: boolean;
  readonly pairNudge?: boolean;
  readonly canLeave?: boolean;
  readonly notice?: string;
  readonly onInvite: () => void;
  readonly onPair: () => void;
  readonly onLeave?: () => void;
  readonly onCafe?: () => void;
  readonly onReplayGuide?: () => void;
  readonly onPermissions?: () => void;
  readonly onCalendar?: () => void;
  readonly onReconnect?: () => void;
  readonly destinations?: ReactNode;
  readonly headerMeta?: ReactNode;
  readonly navigationOpen?: boolean;
  readonly onCloseNavigation?: () => void;
  readonly children: ReactNode;
}) {
  const t = useCollectiveText();
  const hasWorldRail = !embedded && Boolean(collectives?.length);
  return (
    <main
      className="collective-shell"
      data-testid="collective-product-shell"
      data-embedded={embedded}
      data-world-rail={hasWorldRail}
      data-navigation-open={navigationOpen}
    >
      <CollectiveWorldRail
        activeCollective={collective}
        collectives={collectives}
        onHome={onHome}
        onSelectCollective={onSelectCollective}
        visible={!embedded}
      />
      {navigationOpen && (
        <button type="button" className="navigation-scrim" aria-label={t('关闭频道导航')} onClick={onCloseNavigation} />
      )}
      <aside className="destination-pane" data-spatial-role="destination-pane" aria-label={t('共同家园导航')}>
        <header className="destination-header">
          <DestinationTitle
            collective={collective}
            onHome={onHome}
            meta={headerMeta}
            canSteward={canSteward}
            canLeave={canLeave}
            onInvite={onInvite}
            onCafe={onCafe}
            onReplayGuide={onReplayGuide}
            onPermissions={onPermissions}
            onCalendar={onCalendar}
            onReconnect={onReconnect}
            onLeave={onLeave}
          />
          <button type="button" className="navigation-close" aria-label={t('收起频道导航')} onClick={onCloseNavigation}>
            ×
          </button>
        </header>
        {destinations}
        <footer className="destination-footer">
          {embedded && canPair && (
            <div className="steward-actions">
              <button type="button" className={pairNudge ? 'pair-nudge' : undefined} data-guide-pair onClick={onPair}>
                连接此 Café
              </button>
            </div>
          )}
          {notice && <p className="destination-notice">{t(notice)}</p>}
          {connection === 'offline' && <p className="connection-line">暂时离线 · 发送失败后可以重试</p>}
        </footer>
      </aside>
      <section className="primary-scene" data-spatial-role="primary-scene">
        {children}
      </section>
    </main>
  );
}
