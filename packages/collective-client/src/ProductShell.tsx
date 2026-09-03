import type { ReactNode } from 'react';

import type { CollectiveMembership } from './client-types.js';

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m4 11 8-7 8 7v8a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1Z" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </svg>
  );
}

export function ProductShell({
  embedded,
  collective,
  connection,
  canSteward,
  canPair,
  notice,
  onInvite,
  onPair,
  children,
}: {
  readonly embedded: boolean;
  readonly collective?: CollectiveMembership;
  readonly connection: 'online' | 'offline';
  readonly canSteward: boolean;
  readonly canPair: boolean;
  readonly notice?: string;
  readonly onInvite: () => void;
  readonly onPair: () => void;
  readonly children: ReactNode;
}) {
  return (
    <main className="collective-shell" data-embedded={embedded ? 'true' : 'false'}>
      {!embedded && (
        <aside className="global-rail" data-spatial-role="global-rail" aria-label="世界切换">
          <div className="brand-mark" role="img" aria-label="Clowder AI Collective">
            C
          </div>
          <nav>
            <button type="button" className="rail-button" disabled title="回到我的 Café 需要从 Clowder AI 打开">
              <HomeIcon />
              <span>我的 Café</span>
            </button>
            <button type="button" className="rail-button rail-button-active" aria-current="page">
              <span className="world-mark">共</span>
              <span>Collective</span>
            </button>
          </nav>
          <button type="button" className="rail-button rail-tail" disabled>
            <BellIcon />
            <span>Needs Me</span>
          </button>
        </aside>
      )}

      <aside className="destination-pane" data-spatial-role="destination-pane">
        <header className="destination-header">
          <span>COLLECTIVE</span>
          <h1>{collective?.name ?? '共同家园'}</h1>
          <p>{connection === 'online' ? '共同现场已连接' : '暂时离线，正在等待恢复'}</p>
        </header>
        <label className="destination-search">
          <span aria-hidden="true">⌕</span>
          <input type="search" placeholder="搜索这个 Collective" disabled />
        </label>
        <nav className="destination-list" aria-label="Collective 目的地">
          <p>频道</p>
          <button type="button" className="destination-item destination-item-active" aria-current="page">
            <span className="destination-symbol">#</span>
            <span>
              <strong>general</strong>
              <small>共同讨论与回应</small>
            </span>
          </button>
        </nav>
        <footer className="destination-footer">
          {(canSteward || (embedded && canPair)) && (
            <div className="steward-actions">
              {canSteward && (
                <button type="button" onClick={onInvite}>
                  邀请成员
                </button>
              )}
              {embedded && canPair && (
                <button type="button" onClick={onPair}>
                  连接此 Café
                </button>
              )}
            </div>
          )}
          {notice && <p className="destination-notice">{notice}</p>}
          <p className="connection-line">
            <span data-status={connection} />
            {connection === 'online' ? '消息来自同一共同现场' : '离线期间不会冒充已送达'}
          </p>
        </footer>
      </aside>

      <section className="primary-scene" data-spatial-role="primary-scene">
        {children}
      </section>
    </main>
  );
}
