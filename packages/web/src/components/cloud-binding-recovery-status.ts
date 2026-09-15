export interface PersonalChromeRecoveryStatus {
  connectionIssue?: string;
  titleSyncMessage?: string;
}

interface PluginStatus {
  artifact?: { helper?: string };
  live?: { status?: string };
  titleSync?: { status?: string; errorCode?: string; updatedCount?: number; requestedCount?: number };
}

const syncFailureMessages: Record<string, string> = {
  HELPER_UPDATE_REQUIRED: '连接组件需要更新，已有会话授权仍保留。请在插件设置中修复后再刷新。',
  HELPER_NOT_INSTALLED: '本机连接组件尚未就绪，请在插件设置中检查。',
  EXTENSION_RELOAD_REQUIRED: 'Chrome 扩展需要重载，已有会话授权仍保留。重载后再刷新名称。',
  STALE_HELPER: '连接组件已更新，但 Chrome 仍在使用旧组件。重载扩展后再刷新。',
  STALE_HELPER_PROTOCOL: 'Chrome 仍在使用旧连接组件，请在插件设置中更新并重载扩展。',
  CHROME_DISCONNECTED: '暂时无法连接 Chrome。请确认扩展已连接，再刷新名称。',
  TITLE_SYNC_TIMEOUT: '名称同步超时。请确认 Chrome 扩展已连接后再试。',
  AUTHORIZATION_INVALID: '暂时无法读取会话授权，请在插件设置中检查。',
  UNSUPPORTED_PLATFORM: '当前系统暂不支持名称同步。',
};

function connectionIssueFor(state: PluginStatus): string | undefined {
  let connectionIssue: string | undefined;
  if (state.artifact?.helper === 'stale' || state.artifact?.helper === 'invalid') {
    connectionIssue = syncFailureMessages.HELPER_UPDATE_REQUIRED;
  } else if (state.artifact?.helper === 'absent') {
    connectionIssue = syncFailureMessages.HELPER_NOT_INSTALLED;
  } else if (state.live?.status === 'stale_adapter' || state.live?.status === 'restart_required') {
    connectionIssue = syncFailureMessages.EXTENSION_RELOAD_REQUIRED;
  } else if (state.live?.status === 'degraded' || state.live?.status === 'failed') {
    connectionIssue = syncFailureMessages.CHROME_DISCONNECTED;
  }
  return connectionIssue;
}

function titleSyncMessageFor(sync: PluginStatus['titleSync']): string | undefined {
  let titleSyncMessage: string | undefined;
  if (sync?.status === 'unavailable') {
    titleSyncMessage =
      syncFailureMessages[sync.errorCode ?? ''] ?? '这次没有完成名称同步，请稍后再试；已保存的名称仍保留。';
  } else if (
    sync?.status === 'synced' &&
    typeof sync.updatedCount === 'number' &&
    typeof sync.requestedCount === 'number' &&
    Number.isInteger(sync.updatedCount) &&
    Number.isInteger(sync.requestedCount) &&
    sync.updatedCount >= 0 &&
    sync.updatedCount <= sync.requestedCount &&
    sync.requestedCount <= 32
  ) {
    titleSyncMessage =
      sync.updatedCount === 0
        ? '未读到可同步的名称。请打开原对话，等待标题加载后再刷新。'
        : `已同步 ${sync.updatedCount} 个会话名称。${sync.updatedCount < sync.requestedCount ? '其余会话尚未读到名称，可打开原对话后再刷新。' : ''}`;
  }
  return titleSyncMessage;
}

export function projectPersonalChromeRecoveryStatus(state: PluginStatus): PersonalChromeRecoveryStatus {
  const connectionIssue = connectionIssueFor(state);
  const titleSyncMessage = titleSyncMessageFor(state.titleSync);
  return { ...(connectionIssue ? { connectionIssue } : {}), ...(titleSyncMessage ? { titleSyncMessage } : {}) };
}
