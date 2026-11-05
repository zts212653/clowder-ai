export interface CommunityPrIndexStatus {
  publishedGeneration: string | null;
  refreshStatus: 'never' | 'complete' | 'incomplete' | 'failed' | 'limit_exceeded';
}

export function CommunityPrSyncStatus({
  status,
  error,
  busy,
  onContinue,
  retryLabel,
}: {
  status?: CommunityPrIndexStatus;
  error?: string;
  busy: boolean;
  onContinue: (restart: boolean) => void;
  retryLabel?: string;
}) {
  if (!error && (!status || status.refreshStatus === 'complete')) return null;
  const limited = status?.refreshStatus === 'limit_exceeded';
  const incomplete = status?.refreshStatus === 'incomplete';
  const message =
    error ??
    (incomplete
      ? 'PR 同步尚未完成。'
      : limited
        ? 'PR 数量或评审记录超出同步上限。'
        : status?.refreshStatus === 'never'
          ? 'PR 尚未同步。'
          : 'PR 同步失败。');
  return (
    <output className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-cafe-muted border-b border-cafe-subtle/20">
      <span>
        {message} {status?.publishedGeneration ? '当前显示上次完整结果。' : '尚无完整的 PR 结果。'}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => onContinue(limited)}
        className="text-cafe-interactive disabled:opacity-50"
      >
        {retryLabel ?? (limited ? '重新同步 PR' : incomplete ? '继续同步 PR' : '重试 PR')}
      </button>
    </output>
  );
}
