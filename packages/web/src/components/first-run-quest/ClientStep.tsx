'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { AccountsResponse } from '../hub-accounts.types';
import { mergeDetectedAuthStatus, type OnboardingClientDraft } from './onboarding-journey';

export type DetectedClient = OnboardingClientDraft;

interface ClientStepProps {
  onSelect: (clients: DetectedClient[]) => void;
  savedClients?: readonly OnboardingClientDraft[];
  onClientsChange?: (clients: DetectedClient[]) => void;
}

function deriveAuthStatus(
  client: Omit<DetectedClient, 'authStatus'>,
  accounts: AccountsResponse['providers'],
): OnboardingClientDraft['authStatus'] {
  if (!client.installed) return 'not_installed';
  if (client.authenticated) return 'ready';
  const matching = accounts.filter(
    (account) =>
      account.id === client.client || account.clientId === client.provider || account.provider === client.provider,
  );
  if (matching.some((account) => account.authType === 'api_key' && account.hasApiKey)) return 'ready';
  if (client.hasApiKey) return 'ready';
  return 'login_required';
}

function detectedAuthType(client: Omit<DetectedClient, 'authStatus'>): 'environment' | 'native' | 'none' {
  if (client.authType === 'environment' || client.authType === 'native' || client.authType === 'none')
    return client.authType;
  return client.hasApiKey ? 'environment' : client.authenticated ? 'native' : 'none';
}

function statusLabel(status: OnboardingClientDraft['authStatus']): string {
  if (status === 'ready') return '可用';
  if (status === 'pending') return '等待登录';
  if (status === 'not_installed') return '未安装';
  return '需要登录';
}

export function ClientStep({ onSelect, savedClients = [], onClientsChange }: ClientStepProps) {
  const [clients, setClients] = useState<DetectedClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState(false);
  const savedRef = useRef(savedClients);
  const onChangeRef = useRef(onClientsChange);
  savedRef.current = savedClients;
  onChangeRef.current = onClientsChange;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    Promise.all([
      apiFetch('/api/first-run/available-clients').then(async (res) => {
        if (!res.ok) throw new Error('Failed to detect clients');
        return (await res.json()) as { clients: Array<Omit<DetectedClient, 'authStatus'>> };
      }),
      apiFetch('/api/accounts')
        .then(async (res) => {
          if (!res.ok) return { projectPath: '', providers: [] } as AccountsResponse;
          return (await res.json()) as AccountsResponse;
        })
        .catch(() => ({ providers: [] })),
    ])
      .then(([detected, accounts]) => {
        if (cancelled) return;
        const next = detected.clients.map((client) => ({
          ...client,
          authType: detectedAuthType(client),
          authStatus: mergeDetectedAuthStatus(
            deriveAuthStatus(client, accounts.providers ?? []),
            savedRef.current.find((saved) => saved.client === client.client)?.authStatus,
          ),
        }));
        setClients(next);
        onChangeRef.current?.(next);
      })
      .catch(() => {
        if (!cancelled) {
          setClients([]);
          setError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const installed = useMemo(() => clients.filter((client) => client.installed), [clients]);
  const ready = useMemo(() => installed.filter((client) => client.authStatus === 'ready'), [installed]);
  const selectedClients = ready.filter((client) => selected.includes(client.client));
  const choose = (client: DetectedClient) => {
    if (client.authStatus !== 'ready') return;
    setSelected((current) =>
      current.includes(client.client) ? current.filter((id) => id !== client.client) : [...current, client.client],
    );
    if (ready.length === 1) onSelect([client]);
  };

  const startLogin = (client: DetectedClient) => {
    const next = clients.map((item) =>
      item.client === client.client ? { ...item, authStatus: 'pending' as const } : item,
    );
    setClients(next);
    onClientsChange?.(next);
  };

  if (loading) return <p className="py-8 text-center text-sm text-cafe-muted">正在检测客户端...</p>;

  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold text-cafe-secondary">选择协作客户端</h4>
      <p className="mb-4 text-xs text-cafe-muted">
        可以同时启用多个客户端。只有安装并完成认证的客户端才能加入真实团队。
      </p>

      {error ? (
        <p role="alert" className="text-sm text-conn-red-text">
          客户端检测失败，请重新检测。
        </p>
      ) : installed.length === 0 ? (
        <div className="rounded-xl border border-conn-amber-ring bg-conn-amber-bg p-4 text-sm text-conn-amber-text">
          未检测到已安装的 CLI 客户端，请先安装 Claude Code、Codex、Gemini 或 OpenCode。
        </div>
      ) : (
        <div data-testid="first-run-client-step" className="space-y-2">
          {installed.map((client) => {
            const isSelected = selected.includes(client.client);
            const selectable = client.authStatus === 'ready';
            return (
              <div
                data-testid={`first-run-client-${client.client}`}
                key={client.client}
                className={`flex items-center gap-3 rounded-xl border p-3 text-left transition ${
                  isSelected
                    ? 'border-[var(--semantic-warning)] bg-conn-amber-bg shadow-sm'
                    : 'border-[var(--console-border-soft)] bg-cafe-surface-canvas hover:border-conn-amber-ring'
                } ${!selectable ? 'opacity-70' : ''}`}
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-conn-green-bg text-conn-green-text">
                  {isSelected ? '✓' : client.authStatus === 'ready' ? '○' : '!'}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-cafe">{client.label}</span>
                  {client.version && <span className="ml-2 text-xs text-cafe-muted">{client.version}</span>}
                </div>
                <span className="text-xs text-cafe-muted">{statusLabel(client.authStatus)}</span>
                {selectable ? (
                  <button
                    data-testid={`first-run-select-${client.client}`}
                    type="button"
                    onClick={() => choose(client)}
                    className="text-xs text-conn-green-text"
                  >
                    {client.label}
                  </button>
                ) : client.authStatus === 'login_required' ? (
                  <button
                    data-testid={`first-run-login-${client.client}`}
                    type="button"
                    onClick={() => startLogin(client)}
                    className="text-xs text-conn-amber-text"
                  >
                    去登录
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {clients
        .filter((client) => client.authStatus === 'pending')
        .map((client) => (
          <p key={client.client} className="mt-3 text-xs text-cafe-muted">
            请在终端运行 <code>{client.cli}</code>，按客户端提示完成登录，然后点击「重新检测」。
          </p>
        ))}

      {clients.some((client) => !client.installed) && (
        <p className="mt-4 text-xs text-cafe-muted">
          未安装：
          {clients
            .filter((client) => !client.installed)
            .map((client) => client.label)
            .join('、')}
        </p>
      )}

      <button type="button" onClick={() => setRefreshKey((key) => key + 1)} className="mt-3 text-xs text-cafe-muted">
        重新检测
      </button>

      {ready.length > 1 && (
        <button
          type="button"
          disabled={selectedClients.length === 0}
          onClick={() => onSelect(selectedClients)}
          className="mt-4 w-full rounded-lg bg-[var(--semantic-warning)] py-2.5 text-sm font-semibold text-[var(--cafe-surface)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          继续配置 {selectedClients.length > 0 ? `(${selectedClients.length})` : ''}
        </button>
      )}
    </div>
  );
}
