import type { ReactNode } from 'react';
import type { CollectiveMembership } from './client-types.js';

function connectionLabel(
  connection: 'online' | 'offline',
  embedded: boolean,
  canPair: boolean,
  cafeConnection?: { readonly catCount?: number },
): string {
  if (connection === 'offline') return '暂时离线 · 发送失败后可以重试';
  if (!embedded) return '共同家园在线';
  if (cafeConnection) {
    return cafeConnection.catCount === undefined
      ? '这台 Café 已连接 · 正在读取伙伴'
      : `这台 Café 已连接 · ${cafeConnection.catCount} 位猫猫在场`;
  }
  return canPair ? '共同家园在线 · 这台 Café 还没连接' : '共同家园在线';
}

export function ProductShell({
  embedded,
  collective,
  collectives,
  onSelectCollective,
  connection,
  canSteward,
  canPair,
  cafeConnection,
  pairNudge = false,
  canLeave = false,
  notice,
  onInvite,
  onPair,
  onLeave,
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
  readonly connection: 'online' | 'offline';
  readonly canSteward: boolean;
  readonly canPair: boolean;
  readonly cafeConnection?: { readonly catCount?: number };
  readonly pairNudge?: boolean;
  readonly canLeave?: boolean;
  readonly notice?: string;
  readonly onInvite: () => void;
  readonly onPair: () => void;
  readonly onLeave?: () => void;
  readonly destinations?: ReactNode;
  readonly headerMeta?: ReactNode;
  readonly navigationOpen?: boolean;
  readonly onCloseNavigation?: () => void;
  readonly children: ReactNode;
}) {
  const hasWorldRail = !embedded && Boolean(collectives?.length);
  return (
    <main
      className="collective-shell"
      data-testid="collective-product-shell"
      data-embedded={embedded}
      data-world-rail={hasWorldRail}
      data-navigation-open={navigationOpen}
    >
      {hasWorldRail && (
        <aside className="global-rail" data-spatial-role="global-rail" aria-label="选择共同家园">
          <div className="brand-mark" role="img" aria-label="Clowder AI Collective">
            C
          </div>
          <nav>
            {collectives?.map((item) => (
              <button
                key={item.collectiveId}
                type="button"
                className={`rail-button ${item.collectiveId === collective?.collectiveId ? 'rail-button-active' : ''}`}
                aria-label={item.name}
                aria-current={item.collectiveId === collective?.collectiveId ? 'page' : undefined}
                onClick={() => onSelectCollective?.(item.collectiveId)}
              >
                <span className="world-mark">{item.name.slice(0, 1)}</span>
                <span>{item.name}</span>
              </button>
            ))}
          </nav>
        </aside>
      )}
      {navigationOpen && (
        <button type="button" className="navigation-scrim" aria-label="关闭频道导航" onClick={onCloseNavigation} />
      )}
      <aside className="destination-pane" data-spatial-role="destination-pane" aria-label="共同家园导航">
        <header className="destination-header">
          <h1>{collective?.name ?? '共同家园'}</h1>
          {headerMeta ? (
            <p>{headerMeta}</p>
          ) : (
            <p>{connection === 'offline' ? '暂时离线，正在等待恢复' : '人和猫一起交流的地方'}</p>
          )}
          <button type="button" className="navigation-close" aria-label="收起频道导航" onClick={onCloseNavigation}>
            ×
          </button>
        </header>
        {destinations}
        <footer className="destination-footer">
          {(canSteward || (embedded && canPair) || canLeave) && (
            <div className="steward-actions">
              {canSteward && (
                <button type="button" onClick={onInvite}>
                  邀请成员
                </button>
              )}
              {embedded && canPair && (
                <button type="button" className={pairNudge ? 'pair-nudge' : undefined} data-guide-pair onClick={onPair}>
                  连接此 Café
                </button>
              )}
              {canLeave && onLeave && (
                <button type="button" onClick={onLeave}>
                  退出共同家园
                </button>
              )}
            </div>
          )}
          {notice && <p className="destination-notice">{notice}</p>}
          <p className="connection-line">
            <span data-status={connection} />
            {connectionLabel(connection, embedded, canPair, cafeConnection)}
          </p>
        </footer>
      </aside>
      <section className="primary-scene" data-spatial-role="primary-scene">
        {children}
      </section>
    </main>
  );
}
