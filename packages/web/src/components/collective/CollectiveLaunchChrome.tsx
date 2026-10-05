'use client';

import type { CollectiveConnectionProjection, CollectiveConnectorStatus } from './collective-client';
import { normalizeCollectiveServiceUrl } from './collective-client';
import { localServiceAction, localServiceDescription } from './collective-launch-copy';

export function CollectiveConnectorBoundary({
  status,
  error,
}: {
  readonly status?: CollectiveConnectorStatus;
  readonly error?: string;
}) {
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

export function CollectiveServiceSetup({
  status,
  busy,
  serviceInput,
  onServiceInput,
  onProvision,
  onOpen,
  onError,
}: {
  readonly status: CollectiveConnectorStatus;
  readonly busy?: 'provision' | 'reconnect' | 'revoke';
  readonly serviceInput: string;
  readonly onServiceInput: (value: string) => void;
  readonly onProvision: () => void;
  readonly onOpen: (serviceUrl: string) => void;
  readonly onError: (error?: string) => void;
}) {
  return (
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
          onClick={onProvision}
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
                onError('请输入有效的 http(s) Service 地址');
                return;
              }
              onOpen(normalized);
              onError(undefined);
            }}
          >
            <input
              aria-label="Collective Service 地址"
              value={serviceInput}
              onChange={(event) => onServiceInput(event.target.value)}
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
  );
}

export function CollectiveLaunchNotice({
  connectorError,
  worldError,
  workError,
  pairingError,
  entryError,
  entryBusy,
}: {
  readonly connectorError?: string;
  readonly worldError?: string;
  readonly workError?: string;
  readonly pairingError?: string;
  readonly entryError?: string;
  readonly entryBusy?: boolean;
}) {
  const error = connectorError ?? worldError ?? workError ?? pairingError ?? entryError;
  if (!error && !entryBusy) return null;
  return (
    <div
      className={`absolute inset-x-0 top-0 z-10 px-4 py-2 text-center text-xs ${error ? 'bg-conn-red-bg text-conn-red-text' : 'bg-conn-amber-bg text-conn-amber-text'}`}
    >
      {error ?? 'Clowder AI 正在安全托管连接凭据…'}
    </div>
  );
}

export function CollectiveConnectionPicker({
  visible,
  connections,
  onSelect,
}: {
  readonly visible: boolean;
  readonly connections: readonly CollectiveConnectionProjection[];
  readonly onSelect: (connection: CollectiveConnectionProjection) => void;
}) {
  if (!visible) return null;
  return (
    <section className="absolute inset-0 z-10 grid place-items-center bg-[var(--cafe-surface-canvas)] p-6">
      <div className="w-full max-w-lg space-y-3">
        <h1 className="mb-5 text-2xl font-semibold">进入哪个共同家园？</h1>
        {connections.map((item) => (
          <button
            key={item.connectionId}
            type="button"
            className="block w-full rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-4 text-left"
            onClick={() => onSelect(item)}
          >
            <strong className="block">{item.endpointLabel}</strong>
            <span className="text-xs text-cafe-muted">
              {new URL(item.serviceUrl).host} ({item.endpointId.slice(-6)})
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
