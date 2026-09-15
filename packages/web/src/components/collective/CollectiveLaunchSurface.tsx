'use client';

import {
  type CollectiveF290ExperienceHostInboundMessage,
  type CollectiveF290ExperienceResultRejectionReason,
  type CollectiveF290ExperienceWorkRef,
  collectiveF290ExperienceHostInboundMessageSchema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CollectiveParticipationPanel } from './CollectiveParticipationPanel';
import {
  type CollectiveConnectionProjection,
  type CollectiveConnectorStatus,
  type CollectivePairingIntentMessage,
  canonicalClientUrl,
  type LocalCollectiveServiceLaunch,
  normalizeCollectiveServiceUrl,
} from './collective-client';
import { localServiceAction, localServiceDescription } from './collective-launch-copy';
import { F290HostExperiencePanel } from './F290HostExperiencePanel';
import { useCollectivePairingBridge } from './use-collective-pairing-bridge';

const STATUS_REFRESH_MS = 5_000;

function preferredConnection(
  connections: readonly CollectiveConnectionProjection[],
  selectedId?: string,
): CollectiveConnectionProjection | undefined {
  return selectedId
    ? connections.find((connection) => connection.connectionId === selectedId)
    : connections.length === 1
      ? connections[0]
      : undefined;
}

function hostResultReceiptCopy(reason: CollectiveF290ExperienceResultRejectionReason) {
  switch (reason) {
    case 'participation_revoked':
      return '参与已撤回；未回传公开结果。';
    case 'connection_offline':
      return 'Client 暂时离线；未回传公开结果。';
    case 'unknown_work':
      return 'Client 不认识这项 Work；未回传公开结果。';
  }
}

function trustedF290ExperienceHostInbound(
  event: MessageEvent<unknown>,
  iframe: HTMLIFrameElement | null,
  serviceUrl: string,
): CollectiveF290ExperienceHostInboundMessage | undefined {
  if (event.source !== iframe?.contentWindow || event.origin !== serviceUrl) return undefined;
  const parsed = collectiveF290ExperienceHostInboundMessageSchema.safeParse(event.data);
  return parsed.success ? parsed.data : undefined;
}

function matchesPendingHostResult(
  workRef: CollectiveF290ExperienceWorkRef,
  activeWorkRef: CollectiveF290ExperienceWorkRef | undefined,
  pendingWorkRef: CollectiveF290ExperienceWorkRef | undefined,
) {
  return activeWorkRef === workRef && pendingWorkRef === workRef;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This existing connector lifecycle composes independent setup, pairing, recovery, and revocation states; splitting it while adding the candidate seam would blur their state ownership.
export function CollectiveLaunchSurface({
  initialServiceUrl = process.env.NEXT_PUBLIC_COLLECTIVE_SERVICE_URL ?? '',
}: {
  readonly initialServiceUrl?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const selectedConnectionRef = useRef<string>();
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>();
  const [status, setStatus] = useState<CollectiveConnectorStatus>();
  const [serviceInput, setServiceInput] = useState(initialServiceUrl);
  const [serviceUrl, setServiceUrl] = useState(() => normalizeCollectiveServiceUrl(initialServiceUrl));
  const [launchUrl, setLaunchUrl] = useState(() => normalizeCollectiveServiceUrl(initialServiceUrl));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<'provision' | 'pair' | 'reconnect' | 'revoke'>();
  const [hostExperienceOpen, setHostExperienceOpen] = useState(false);
  const [hostExperienceWorkRef, setHostExperienceWorkRef] = useState<CollectiveF290ExperienceWorkRef>();
  const [hostExperiencePendingWorkRef, setHostExperiencePendingWorkRef] = useState<CollectiveF290ExperienceWorkRef>();
  const [hostExperienceResultNotice, setHostExperienceResultNotice] = useState<string>();
  const serviceUrlRef = useRef(serviceUrl);
  const hostExperienceWorkRefRef = useRef<CollectiveF290ExperienceWorkRef>();
  const hostExperiencePendingWorkRefRef = useRef<CollectiveF290ExperienceWorkRef>();
  const experienceGate =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('experienceGate') === 'f290-assembly';

  const closeHostExperience = useCallback(() => {
    hostExperienceWorkRefRef.current = undefined;
    hostExperiencePendingWorkRefRef.current = undefined;
    setHostExperienceOpen(false);
    setHostExperienceWorkRef(undefined);
    setHostExperiencePendingWorkRef(undefined);
    setHostExperienceResultNotice(undefined);
  }, []);
  const openHostExperience = useCallback((workRef?: CollectiveF290ExperienceWorkRef) => {
    hostExperienceWorkRefRef.current = workRef;
    hostExperiencePendingWorkRefRef.current = undefined;
    setHostExperienceOpen(true);
    setHostExperienceWorkRef(workRef);
    setHostExperiencePendingWorkRef(undefined);
    setHostExperienceResultNotice(undefined);
  }, []);
  const setExperienceService = useCallback(
    (nextServiceUrl: string, nextLaunchUrl = nextServiceUrl) => {
      if (serviceUrlRef.current !== nextServiceUrl) closeHostExperience();
      serviceUrlRef.current = nextServiceUrl;
      setServiceUrl(nextServiceUrl);
      setLaunchUrl(nextLaunchUrl);
      setServiceInput(nextServiceUrl);
    },
    [closeHostExperience],
  );

  const load = useCallback(
    async (afterMutation = false) => {
      try {
        const response = await apiFetch(
          '/api/plugins/collective-connector',
          undefined,
          afterMutation ? { afterCurrentGet: true } : undefined,
        );
        const body = (await response.json().catch(() => ({}))) as CollectiveConnectorStatus & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `Connector status failed (${response.status})`);
        setStatus(body);
        const active = preferredConnection(body.connections, selectedConnectionRef.current);
        if (active) {
          setExperienceService(active.serviceUrl);
        } else if (body.localService?.state === 'ready') {
          setExperienceService(body.localService.serviceUrl);
        }
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Connector status failed');
      }
    },
    [setExperienceService],
  );

  const provisionLocalService = useCallback(async () => {
    setBusy('provision');
    setError(undefined);
    try {
      const response = await apiFetch('/api/plugins/collective-connector/service/provision', { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as LocalCollectiveServiceLaunch & { error?: string };
      if (!response.ok || !body.service || !body.launchUrl) {
        throw new Error(body.error ?? `Service creation failed (${response.status})`);
      }
      const normalized = normalizeCollectiveServiceUrl(body.service.serviceUrl);
      if (!normalized || new URL(body.launchUrl).origin !== normalized) {
        throw new Error('Host returned an invalid local Service address');
      }
      setStatus((current) => (current ? { ...current, localService: body.service } : current));
      setExperienceService(normalized, body.launchUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Service creation failed');
    } finally {
      setBusy(undefined);
    }
  }, [setExperienceService]);

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
        const body = (await response.json().catch(() => ({}))) as { error?: string; connectionId?: string };
        if (!response.ok) throw new Error(body.error ?? `Pairing failed (${response.status})`);
        if (body.connectionId) {
          selectedConnectionRef.current = body.connectionId;
          setSelectedConnectionId(body.connectionId);
        }
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

  const connection = status ? preferredConnection(status.connections, selectedConnectionId) : undefined;
  const activeConnectionRef = useRef<string>();
  useEffect(() => {
    const previousConnectionId = activeConnectionRef.current;
    if (previousConnectionId && previousConnectionId !== connection?.connectionId) closeHostExperience();
    activeConnectionRef.current = connection?.connectionId;
  }, [closeHostExperience, connection?.connectionId]);
  const frameUrl = useMemo(() => {
    if (!launchUrl || typeof window === 'undefined') return undefined;
    const url = new URL(canonicalClientUrl(launchUrl, window.location.origin));
    if (connection && new URL(connection.serviceUrl).origin === url.origin)
      url.searchParams.set('collectiveId', connection.collectiveId);
    if (experienceGate) url.searchParams.set('experienceGate', 'f290-assembly');
    return url.toString();
  }, [launchUrl, connection, experienceGate]);

  useEffect(() => {
    if (!experienceGate || !serviceUrl) return;
    const onExperienceMessage = (event: MessageEvent<unknown>) => {
      const message = trustedF290ExperienceHostInbound(event, iframeRef.current, serviceUrl);
      if (!message) return;
      switch (message.type) {
        case 'collective:f290-experience-close-cafe':
          closeHostExperience();
          return;
        case 'collective:f290-experience-open-cafe':
          openHostExperience();
          return;
        case 'collective:f290-experience-open-work':
          openHostExperience(message.workRef);
          return;
        case 'collective:f290-experience-result-accepted':
          if (
            matchesPendingHostResult(
              message.workRef,
              hostExperienceWorkRefRef.current,
              hostExperiencePendingWorkRefRef.current,
            )
          )
            closeHostExperience();
          return;
        case 'collective:f290-experience-result-rejected':
          if (
            !matchesPendingHostResult(
              message.workRef,
              hostExperienceWorkRefRef.current,
              hostExperiencePendingWorkRefRef.current,
            )
          )
            return;
          hostExperiencePendingWorkRefRef.current = undefined;
          setHostExperiencePendingWorkRef(undefined);
          setHostExperienceResultNotice(hostResultReceiptCopy(message.reason));
      }
    };
    window.addEventListener('message', onExperienceMessage);
    return () => window.removeEventListener('message', onExperienceMessage);
  }, [closeHostExperience, experienceGate, openHostExperience, serviceUrl]);

  const returnHostExperienceResult = useCallback(
    (workRef: CollectiveF290ExperienceWorkRef) => {
      if (
        !serviceUrl ||
        !iframeRef.current?.contentWindow ||
        hostExperienceWorkRefRef.current !== workRef ||
        hostExperiencePendingWorkRefRef.current
      )
        return;
      hostExperiencePendingWorkRefRef.current = workRef;
      setHostExperiencePendingWorkRef(workRef);
      setHostExperienceResultNotice(undefined);
      iframeRef.current.contentWindow.postMessage(
        { type: 'collective:f290-experience-result-ready', workRef },
        serviceUrl,
      );
    },
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
      className={`relative h-full min-h-0 overflow-hidden bg-[var(--cafe-surface-canvas)] ${experienceGate ? 'flex flex-col' : ''}`}
      data-testid="collective-launch-surface"
    >
      {frameUrl ? (
        <iframe
          ref={iframeRef}
          src={frameUrl}
          title="Collective"
          sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          onLoad={pairingBridge.handleFrameLoad}
          className={
            experienceGate
              ? 'min-h-0 w-full flex-1 border-0 bg-[var(--cafe-surface-sunken)]'
              : 'h-full w-full border-0 bg-[var(--cafe-surface-sunken)]'
          }
        />
      ) : (
        <div className="grid h-full place-items-center p-6">
          <section className="w-full max-w-lg rounded-2xl bg-[var(--console-card-bg)] p-6 shadow-[var(--console-elevation-2)]">
            <p className="text-xs font-semibold uppercase tracking-wider text-cafe-accent">Collective Service</p>
            <h1 className="mt-2 text-2xl font-semibold text-cafe-primary">建立共同家园</h1>
            <p className="mt-3 text-sm leading-6 text-cafe-secondary">
              Clowder AI 会创建并守护一份独立运行的本机 Service。登录凭据由 Service 保存，不需要打开终端或复制 secret。
            </p>
            <button
              type="button"
              disabled={busy !== undefined || status.localService?.state === 'starting'}
              onClick={() => void provisionLocalService()}
              className="mt-5 rounded-lg bg-cafe-accent px-4 py-2 text-sm font-semibold disabled:opacity-50"
              style={{ color: 'var(--cafe-accent-foreground)' }}
            >
              {localServiceAction(status.localService?.state, busy === 'provision')}
            </button>
            {status.localService && (
              <div className="mt-4 rounded-xl bg-[var(--cafe-surface-sunken)] px-3 py-3 text-xs leading-5 text-cafe-muted">
                <p>{localServiceDescription(status.localService.state)}</p>
                <p className="mt-1 break-all">数据：{status.localService.dataDirectory}</p>
                {status.localService.error && <p className="mt-1 text-conn-red-text">{status.localService.error}</p>}
              </div>
            )}
            <details className="mt-5 border-t border-[var(--console-border-soft)] pt-4 text-sm text-cafe-secondary">
              <summary className="cursor-pointer font-medium text-cafe-primary">连接已有 Service</summary>
              <form
                className="mt-3 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const normalized = normalizeCollectiveServiceUrl(serviceInput);
                  if (!normalized) {
                    setError('请输入有效的 http(s) Service 地址');
                    return;
                  }
                  setExperienceService(normalized);
                  setError(undefined);
                }}
              >
                <input
                  aria-label="Collective Service 地址"
                  value={serviceInput}
                  onChange={(event) => setServiceInput(event.target.value)}
                  placeholder="https://collective.example.com"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--console-border-soft)] bg-[var(--cafe-surface-sunken)] px-3 py-2 text-sm text-cafe-primary outline-none focus:border-cafe-accent"
                />
                <button
                  type="submit"
                  className="rounded-lg border border-[var(--console-border-soft)] px-4 py-2 text-sm font-semibold hover:bg-[var(--console-hover-bg)]"
                >
                  打开
                </button>
              </form>
            </details>
          </section>
        </div>
      )}
      {(error || pairingBridge.error || busy === 'pair') && (
        <div
          className={`absolute inset-x-0 top-0 z-10 px-4 py-2 text-center text-xs ${error || pairingBridge.error ? 'bg-conn-red-bg text-conn-red-text' : 'bg-conn-amber-bg text-conn-amber-text'}`}
        >
          {error ?? pairingBridge.error ?? 'Clowder AI 正在安全托管连接凭据…'}
        </div>
      )}
      {status.connections.length > 0 && (
        <div
          className={
            experienceGate
              ? 'relative z-10 shrink-0 space-y-2 border-t border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-3 py-2'
              : 'absolute right-3 top-3 z-10 w-[calc(100%-1.5rem)] max-w-[26rem] space-y-2'
          }
        >
          {status.connections.length > 1 && (
            <label className="flex min-w-0 flex-col gap-1 rounded-xl bg-[var(--console-card-bg)] p-3 text-xs text-cafe-secondary">
              当前 Café 连接
              <select
                aria-label="选择 Café 连接"
                value={connection?.connectionId ?? ''}
                className="w-full min-w-0 rounded-lg border border-[var(--console-border-soft)] bg-[var(--cafe-surface-sunken)] p-2"
                onChange={(event) => {
                  const next = status.connections.find((item) => item.connectionId === event.target.value);
                  if (!next) return;
                  closeHostExperience();
                  selectedConnectionRef.current = next.connectionId;
                  setSelectedConnectionId(next.connectionId);
                  setExperienceService(next.serviceUrl);
                }}
              >
                <option value="" disabled>
                  选择要带猫加入的连接
                </option>
                {status.connections.map((item) => (
                  <option key={item.connectionId} value={item.connectionId}>
                    {item.endpointLabel} · {new URL(item.serviceUrl).host} ({item.endpointId.slice(-6)})
                  </option>
                ))}
              </select>
            </label>
          )}
          {connection && (
            <CollectiveParticipationPanel key={connection.connectionId} connectionId={connection.connectionId} />
          )}
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
      {experienceGate && frameUrl && (
        <F290HostExperiencePanel
          open={hostExperienceOpen}
          activeWorkRef={hostExperienceWorkRef}
          resultPending={hostExperienceWorkRef !== undefined && hostExperiencePendingWorkRef === hostExperienceWorkRef}
          resultNotice={hostExperienceResultNotice}
          onClose={closeHostExperience}
          onOpenWork={openHostExperience}
          onReturnResult={returnHostExperienceResult}
        />
      )}
    </div>
  );
}
