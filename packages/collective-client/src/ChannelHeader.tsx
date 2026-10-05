export function ChannelHeader({
  collectiveName,
  channelId,
  searchCount,
  connection,
  onOpenNavigation,
  onCafe,
  guideCatCount,
}: {
  readonly collectiveName: string;
  readonly channelId: string;
  readonly searchCount?: number;
  readonly connection: 'online' | 'offline';
  readonly onOpenNavigation: () => void;
  readonly onCafe?: () => void;
  readonly guideCatCount?: number;
}) {
  const searching = searchCount !== undefined;
  return (
    <header className="scene-header">
      <button type="button" className="mobile-navigation" aria-label="频道导航" onClick={onOpenNavigation}>
        ☰{guideCatCount !== undefined && <span className="mobile-cat-badge">{guideCatCount}</span>}
      </button>
      <div>
        <p className="scene-eyebrow">{collectiveName}</p>
        <h1>{searching ? '搜索结果' : `# ${channelId}`}</h1>
        <p>{searching ? `找到 ${searchCount} 段相关讨论` : '我们在这里交流、一起推敲；不是每句话都要变成任务。'}</p>
      </div>
      <div className="scene-header-actions">
        {connection === 'offline' && <span className="offline-label">暂时离线</span>}
        {onCafe && (
          <button type="button" className="cafe-window-button" onClick={onCafe}>
            我的 Café
          </button>
        )}
      </div>
    </header>
  );
}
