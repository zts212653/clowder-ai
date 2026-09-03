'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import {
  type CollectiveConnectionProjection,
  type CollectiveConnectorStatus,
  type CollectivePairingIntentMessage,
  canonicalClientUrl,
  normalizeCollectiveServiceUrl,
} from './collective-client';
import { useCollectivePairingBridge } from './use-collective-pairing-bridge';

const STATUS_REFRESH_MS = 5_000;

function preferredConnection(
  connections: readonly CollectiveConnectionProjection[],
): CollectiveConnectionProjection | undefined {
  let latestAuthorized: CollectiveConnectionProjection | undefined;
  let latestOnline: CollectiveConnectionProjection | undefined;
  let latestRevoked: CollectiveConnectionProjection | undefined;
  for (const connection of connections) {
    if (connection.authorityStatus === 'revoked') {
      latestRevoked = connection;
      continue;
    }
    latestAuthorized = connection;
    if (connection.liveStatus === 'online') latestOnline = connection;
  }
  return latestOnline ?? latestAuthorized ?? latestRevoked;
}

export function CollectiveLaunchSurface({
  initialServiceUrl = process.env.NEXT_PUBLIC_COLLECTIVE_SERVICE_URL ?? '',
}: {
  readonly initialServiceUrl?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<CollectiveConnectorStatus>();
  const [serviceInput, setServiceInput] = useState(initialServiceUrl);
  const [serviceUrl, setServiceUrl] = useState(() => normalizeCollectiveServiceUrl(initialServiceUrl));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<'pair' | 'reconnect' | 'revoke'>();

  const load = useCallback(async (afterMutation = false) => {
    try {
      const response = await apiFetch(
        '/api/plugins/collective-connector',
        undefined,
        afterMutation ? { afterCurrentGet: true } : undefined,
      );
      const body = (await response.json().catch(() => ({}))) as CollectiveConnectorStatus & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Connector status failed (${response.status})`);
      setStatus(body);
      const active = preferredConnection(body.connections);
      if (active) {
        setServiceUrl(active.serviceUrl);
        setServiceInput(active.serviceUrl);
      }
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connector status failed');
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = window.setInterval(() => void load(), STATUS_REFRESH_MS);
    return () => window.clearInterval(refresh);
  }, [load]);

  const pair = useCallback(
    async (message: CollectivePairingIntentMessage) => {
      setBusy('pair');
      setError(undefined);
      try {
        const response = await apiFetch('/api/plugins/collective-connector/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            serviceUrl: message.serviceUrl,
            endpointLabel: `Clowder AI on ${window.location.host}`,
            intent: message.intent,
          }),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new Error(body.error ?? `Pairing failed (${response.status})`);
        await load(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Pairing failed');
      } finally {
        setBusy(undefined);
      }
    },
    [load],
  );
  const pairingBridge = useCollectivePairingBridge({ iframeRef, serviceUrl, pair });

  const mutateConnection = useCallback(
    async (operation: 'reconnect' | 'revoke', connectionId: string) => {
      if (operation === 'revoke' && !window.confirm('撤销后 Service 与 Host 都会拒绝此 endpoint 凭据。确认撤销？'))
        return;
      setBusy(operation);
      setError(undefined);
      try {
        const response = await apiFetch(
          `/api/plugins/collective-connector/${encodeURIComponent(connectionId)}/${operation}`,
          { method: 'POST' },
        );
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new Error(body.error ?? `${operation} failed (${response.status})`);
        await load(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : `${operation} failed`);
      } finally {
        setBusy(undefined);
      }
    },
    [load],
  );

  const connection = status ? preferredConnection(status.connections) : undefined;
  const frameUrl = useMemo(
    () =>
      serviceUrl && typeof window !== 'undefined' ? canonicalClientUrl(serviceUrl, window.location.origin) : undefined,
    [serviceUrl],
  );

  if (!status) {
    return (
      <div className="grid h-full place-items-center bg-[var(--cafe-surface-canvas)] p-6 text-sm text-cafe-muted">
        {error ? (
          <section role="alert" className="max-w-md text-center">
            <h1 className="text-lg font-semibold text-cafe-primary">现在还进不去 Collective</h1>
            <p className="mt-2 leading-6 text-cafe-secondary">Connector 状态暂时不可达；数据没有被清空。</p>
            <p className="mt-2 text-xs text-conn-red-text">{error}</p>
          </section>
        ) : (
          '正在打开 Collective…'
        )}
      </div>
    );
  }
  if (status.runtimeStatus === 'inactive') {
    return (
      <div className="grid h-full place-items-center bg-[var(--cafe-surface-canvas)] p-6">
        <section className="max-w-lg rounded-2xl bg-[var(--console-card-bg)] p-7 shadow-[var(--console-elevation-2)]">
          <p className="text-xs font-semibold uppercase tracking-wider text-cafe-accent">Official Connector</p>
          <h1 className="mt-2 text-2xl font-semibold text-cafe-primary">先安装并启用 Collective Connector</h1>
          <p className="mt-3 text-sm leading-6 text-cafe-secondary">
            Connector 负责 Host 凭据、重连、重放与撤销；Collective Service 仍是独立进程。
          </p>
          <a
            href="/settings?s=plugins"
            className="mt-5 inline-flex rounded-lg bg-cafe-accent px-4 py-2 text-sm font-semibold"
            style={{ color: 'var(--cafe-accent-foreground)' }}
          >
            打开插件设置
          </a>
        </section>
      </div>
    );
  }

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden bg-[var(--cafe-surface-canvas)]"
      data-testid="collective-launch-surface"
    >
      {frameUrl ? (
        <iframe
          ref={iframeRef}
          src={frameUrl}
          title="Collective"
          sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          onLoad={pairingBridge.handleFrameLoad}
          className="h-full w-full border-0 bg-[var(--cafe-surface-sunken)]"
        />
      ) : (
        <div className="grid h-full place-items-center p-6">
          <form
            className="flex w-full max-w-md gap-2 rounded-2xl bg-[var(--console-card-bg)] p-5 shadow-[var(--console-elevation-2)]"
            onSubmit={(event) => {
              event.preventDefault();
              const normalized = normalizeCollectiveServiceUrl(serviceInput);
              if (!normalized) {
                setError('请输入有效的 http(s) Service 地址');
                return;
              }
              setServiceUrl(normalized);
              setError(undefined);
            }}
          >
            <input
              aria-label="Collective Service 地址"
              value={serviceInput}
              onChange={(event) => setServiceInput(event.target.value)}
              placeholder="http://localhost:5201"
              className="min-w-0 flex-1 rounded-lg border border-[var(--console-border-soft)] bg-[var(--cafe-surface-sunken)] px-3 py-2 text-sm text-cafe-primary outline-none focus:border-cafe-accent"
            />
            <button
              type="submit"
              className="rounded-lg bg-cafe-accent px-4 py-2 text-sm font-semibold"
              style={{ color: 'var(--cafe-accent-foreground)' }}
            >
              打开
            </button>
          </form>
        </div>
      )}
      {(error || pairingBridge.error || busy === 'pair') && (
        <div
          className={`absolute inset-x-0 top-0 z-10 px-4 py-2 text-center text-xs ${error || pairingBridge.error ? 'bg-conn-red-bg text-conn-red-text' : 'bg-conn-amber-bg text-conn-amber-text'}`}
        >
          {error ?? pairingBridge.error ?? 'Clowder AI 正在安全托管连接凭据…'}
        </div>
      )}
      {connection && (
        <details className="absolute bottom-3 right-3 z-10 w-64 rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)]/95 text-xs text-cafe-secondary shadow-[var(--console-elevation-2)] backdrop-blur">
          <summary className="cursor-pointer list-none px-3 py-2 font-medium">
            {connection.authorityStatus === 'revoked'
              ? 'Café 连接已撤销'
              : `Café 连接${connection.liveStatus === 'online' ? '在线' : '暂时离线'}`}
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
                  disabled={pairingBridge.state !== 'ready' || busy !== undefined}
                  onClick={pairingBridge.requestPairing}
                  className="rounded-lg border border-[var(--console-border-soft)] px-2.5 py-1.5 hover:bg-[var(--console-hover-bg)] disabled:opacity-50"
                >
                  {pairingBridge.state === 'waiting' ? '准备中…' : '重新配对'}
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
                    onClick={() => void mutateConnection('reconnect', connection.connectionId)}
                    className="rounded-lg border border-[var(--console-border-soft)] px-2.5 py-1.5 hover:bg-[var(--console-hover-bg)] disabled:opacity-50"
                  >
                    {busy === 'reconnect' ? '重连中…' : '重连'}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== undefined}
                    onClick={() => void mutateConnection('revoke', connection.connectionId)}
                    className="rounded-lg border border-[var(--console-border-soft)] px-2.5 py-1.5 text-conn-red-text hover:bg-conn-red-bg disabled:opacity-50"
                  >
                    {busy === 'revoke' ? '撤销中…' : '撤销连接'}
                  </button>
                </div>
              </>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
