'use client';
import { useEffect, useRef } from 'react';
import { CollectiveParticipationContent } from './CollectiveParticipationPanel';
import type { CollectiveConnectionProjection } from './collective-client';
import type { useCollectiveParticipation } from './use-collective-participation';
import type { CollectiveWorkPolicyState } from './use-collective-work-policy';
import type { CollectiveWorkPolicyBridge } from './use-collective-work-policy-bridge';

export function CollectiveCafePanel({
  state,
  connection,
  channelId,
  channels,
  busy,
  pairingState,
  onClose,
  onPair,
  onMutate,
  connections,
  onSelectConnection,
  workPolicy,
}: {
  readonly workPolicy?: CollectiveWorkPolicyState;
  readonly policyBridge?: CollectiveWorkPolicyBridge;
  readonly state: ReturnType<typeof useCollectiveParticipation>;
  readonly connection: CollectiveConnectionProjection;
  readonly channelId: string;
  readonly channels: readonly string[];
  readonly busy?: string;
  readonly pairingState: 'waiting' | 'ready' | 'unavailable';
  readonly onClose: () => void;
  readonly onPair: () => void;
  readonly onMutate: (operation: 'reconnect' | 'revoke') => void;
  readonly connections: readonly CollectiveConnectionProjection[];
  readonly onSelectConnection: (id: string) => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <aside
      aria-label="我的 Café"
      className="absolute inset-y-0 right-0 z-20 flex w-[min(420px,94%)] flex-col border-l border-[var(--console-border-soft)] bg-[var(--console-card-bg)] text-cafe-primary shadow-[var(--console-elevation-2)]"
    >
      <header className="flex items-center justify-between border-b border-[var(--console-border-soft)] px-5 py-4">
        <div>
          <p className="text-micro text-cafe-muted">我的 Café · 仅自己可见 · # {channelId}</p>
          <h2 className="mt-1 text-lg font-semibold">管理参与</h2>
        </div>
        <button
          ref={closeButton}
          type="button"
          aria-label="关闭我的 Café"
          className="px-2 text-2xl text-cafe-muted"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        <p className="text-xs leading-5 text-cafe-secondary">
          这里属于你的 Café。家里的对话和工作留在这里，公开回应回到原来的讨论。
        </p>
        <CollectiveParticipationContent
          state={state}
          channelId={channelId}
          channels={channels}
          workPolicy={workPolicy}
          canParticipate={connection.authorityStatus === 'connected'}
        />
        {state.view?.published && (
          <button
            type="button"
            className="w-full rounded-xl bg-[var(--cafe-accent)] px-4 py-2.5 text-sm font-semibold text-white"
            onClick={onClose}
          >
            前往 # {channelId} 点名一只猫
          </button>
        )}
        <details className="border-t border-[var(--console-border-soft)] pt-4 text-xs text-cafe-secondary">
          <summary className="cursor-pointer font-medium">
            {connection.authorityStatus === 'revoked'
              ? 'Café 连接已撤销'
              : `连接设置 · ${connection.liveStatus === 'online' ? '在线' : '暂时离线'}`}
          </summary>
          <div className="border-t border-[var(--console-border-soft)] px-3 py-3">
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
                <p className="mb-3 text-cafe-muted">
                  已接收到第 {connection.lastAckedSequence} 条；排队 {connection.outbox.queued}{' '}
                  条。这里不把“已请求”说成“猫已接住”。
                </p>
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
        </details>
      </div>
    </aside>
  );
}
