import { WATCHER_CONFIG_DEFAULTS } from '@cat-cafe/shared';

// Read-only fixture for the header's useWatcher consumer. No enabled member, model or write route.
export function disabledWatcherRead(request, url, threadIds) {
  if (
    request.method() !== 'GET' ||
    url.search !== '' ||
    !threadIds.some((id) => url.pathname === `/api/threads/${encodeURIComponent(id)}/watcher`)
  )
    return null;
  /** @type {import('../../../src/hooks/useWatcher').WatcherSnapshot} */
  const snapshot = {
    control: { revision: 0 },
    config: { ...WATCHER_CONFIG_DEFAULTS, enabled: false },
    enabled: false,
    maySpeak: false,
    labelMuted: false,
    rolloutEnabled: false,
    reviewing: false,
    memberName: '小太阳',
    capability: { supported: true, mechanism: 'native_revert', maxWorkingContextTokens: 30000, toolPolicy: 'watcher' },
  };
  return { status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) };
}
