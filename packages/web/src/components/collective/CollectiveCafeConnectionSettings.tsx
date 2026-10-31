'use client';

import type { CollectiveConnectionProjection } from './collective-client';

export function CollectiveCafeConnectionSettings({
  connection,
  connections,
  busy,
  pairingState,
  onPair,
  onMutate,
  onSelectConnection,
}: {
  readonly connection: CollectiveConnectionProjection;
  readonly connections: readonly CollectiveConnectionProjection[];
  readonly busy?: string;
  readonly pairingState: 'waiting' | 'ready' | 'unavailable';
  readonly onPair: () => void;
  readonly onMutate: (operation: 'reconnect' | 'revoke') => void;
  readonly onSelectConnection: (id: string) => void;
}) {
  return (
    <div className="text-xs text-cafe-secondary">
      <div className="px-1 py-2">
        <h3 className="text-sm font-semibold text-cafe-primary">
          {connection.authorityStatus === 'revoked'
            ? 'Café 连接已撤销'
            : connection.liveStatus === 'online'
              ? '已连接'
              : '暂时离线'}
        </h3>
      </div>
      <div className="border-t border-[var(--console-border-soft)] px-1 py-4">
        {connection.authorityStatus === 'revoked' ? (
          <>
            <p className="mb-3 text-cafe-muted">
              此 endpoint 凭据已撤销并从 Host 删除。可从当前 Collective 重新发起一次配对。
            </p>
            <button
              type="button"
              aria-label="重新配对"
              disabled={pairingState !== 'ready' || busy !== undefined}
              onClick={onPair}
              className="rounded-lg border border-[var(--console-border-soft)] px-2.5 py-1.5 hover:bg-[var(--console-hover-bg)] disabled:opacity-50"
            >
              {pairingState === 'waiting' ? '准备中…' : '重新配对'}
            </button>
          </>
        ) : (
          <>
            <p className="mb-3 text-cafe-muted">连接状态只表示这台 Café 可以收发，不代表某只猫已经接下工作。</p>
            {!connection.route.configured && connection.inbox.pending > 0 && (
              <p className="mb-3 rounded-lg bg-conn-amber-bg px-2.5 py-2 text-conn-amber-text">
                {connection.inbox.pending} 条消息正在等待设置 Café Thread 去向。
              </p>
            )}
            {connection.inbox.failed > 0 && (
              <p className="mb-3 rounded-lg bg-conn-amber-bg px-2.5 py-2 text-conn-amber-text">
                {connection.inbox.failed} 条消息还没有进入配置的 Thread。更新消息去向后会自动重试。
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy !== undefined}
                onClick={() => void onMutate('reconnect')}
                className="rounded-lg border border-[var(--console-border-soft)] px-2.5 py-1.5 hover:bg-[var(--console-hover-bg)] disabled:opacity-50"
              >
                {busy === 'reconnect' ? '重连中…' : '重连'}
              </button>
              <button
                type="button"
                disabled={busy !== undefined}
                onClick={() => void onMutate('revoke')}
                className="rounded-lg border border-[var(--console-border-soft)] px-2.5 py-1.5 text-conn-red-text hover:bg-conn-red-bg disabled:opacity-50"
              >
                {busy === 'revoke' ? '撤销中…' : '撤销连接'}
              </button>
            </div>
          </>
        )}
      </div>
      {connections.length > 1 && (
        <label className="mt-3 grid min-w-0 gap-2">
          切换 Café 连接
          <select
            aria-label="选择 Café 连接"
            className="min-w-0 w-full rounded-lg border border-[var(--console-border-soft)] bg-[var(--cafe-surface-sunken)] p-2"
            value={connection.connectionId}
            onChange={(event) => onSelectConnection(event.target.value)}
          >
            {connections.map((item) => (
              <option key={item.connectionId} value={item.connectionId}>
                {item.endpointLabel} · {new URL(item.serviceUrl).host} ({item.endpointId.slice(-6)})
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
