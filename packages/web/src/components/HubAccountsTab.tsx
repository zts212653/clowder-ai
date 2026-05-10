'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubAccountItem, type ProfileEditPayload } from './HubAccountItem';
import type { AccountsResponse, ProfileItem } from './hub-accounts.types';
import { type UnifiedAuthEditData, UnifiedAuthModal } from './UnifiedAuthModal';

export function HubAccountsTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [editTarget, setEditTarget] = useState<UnifiedAuthEditData | undefined>(undefined);

  const fetchAccounts = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/api/accounts');
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((body.error as string) ?? '加载失败');
        return;
      }
      const body = (await res.json()) as AccountsResponse;
      setData(body);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchAccounts();
  }, [fetchAccounts]);

  const callApi = useCallback(async (path: string, init: RequestInit) => {
    const res = await apiFetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error((body.error as string) ?? `请求失败 (${res.status})`);
    }
    return body;
  }, []);

  const handleAuthCreated = useCallback(async () => {
    setShowAuthModal(false);
    setEditTarget(undefined);
    await fetchAccounts();
    window.dispatchEvent(new CustomEvent('accounts-changed'));
  }, [fetchAccounts]);

  const deleteAccount = useCallback(
    async (accountId: string) => {
      setBusyId(accountId);
      setError(null);
      try {
        await callApi(`/api/accounts/${accountId}`, { method: 'DELETE' });
        await fetchAccounts();
        window.dispatchEvent(new CustomEvent('accounts-changed'));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [callApi, fetchAccounts],
  );

  const saveAccount = useCallback(
    async (accountId: string, payload: ProfileEditPayload) => {
      setBusyId(accountId);
      setError(null);
      try {
        await callApi(`/api/accounts/${accountId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        await fetchAccounts();
        window.dispatchEvent(new CustomEvent('accounts-changed'));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [callApi, fetchAccounts],
  );

  const handleEdit = useCallback(
    (profileId: string) => {
      const account = (data?.providers ?? []).find((a) => a.id === profileId) as ProfileItem | undefined;
      if (!account) return;
      setEditTarget({
        id: account.id,
        displayName: account.displayName,
        baseUrl: account.baseUrl,
        clientId: account.clientId,
        authType: account.authType,
        models: account.models,
        envVars: account.envVars,
      });
      setShowAuthModal(true);
    },
    [data?.providers],
  );

  if (loading) return <p className="text-sm text-cafe-muted">加载中...</p>;
  if (!data)
    return (
      <div className="flex flex-col items-center justify-center rounded-[28px] bg-[var(--console-card-bg)] py-16 text-center">
        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-[var(--console-card-soft-bg)]">
          <svg
            className="h-8 w-8 text-cafe-muted"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </div>
        <h3 className="text-sm font-semibold text-cafe-secondary">暂无账号数据</h3>
        <p className="mt-1 max-w-[220px] text-xs text-cafe-muted">无法加载账号列表，请检查服务连接后刷新重试</p>
      </div>
    );

  const accounts = data.providers;

  return (
    <div className="space-y-5">
      {error && <p className="text-sm text-conn-red-text bg-conn-red-bg rounded-lg px-3 py-2">{error}</p>}

      <div className="flex items-center justify-between text-xs text-cafe-muted">
        <span>存储路径: {data.configRoot ?? `${data.projectPath}/.cat-cafe`}</span>
      </div>

      <div className="flex items-center justify-end">
        <button
          type="button"
          data-guide-id="accounts.create-form"
          onClick={() => {
            setEditTarget(undefined);
            setShowAuthModal(true);
          }}
          className="flex h-9 items-center gap-2 rounded-lg bg-[var(--cafe-accent)] px-3.5 text-[13px] font-semibold text-[var(--cafe-accent-foreground)] transition-opacity hover:opacity-90"
        >
          + 新增账户认证
        </button>
      </div>

      <div
        role="group"
        aria-label="Account List"
        className="flex flex-col gap-3.5"
        data-guide-id="accounts.account-list"
      >
        {accounts.map((account) => (
          <HubAccountItem
            key={account.id}
            profile={account}
            busy={busyId === account.id}
            onSave={(_id, payload) => saveAccount(account.id, payload)}
            onDelete={() => deleteAccount(account.id)}
            onEdit={handleEdit}
          />
        ))}
      </div>

      <UnifiedAuthModal
        key={editTarget?.id ?? 'create'}
        open={showAuthModal}
        onClose={() => {
          setShowAuthModal(false);
          setEditTarget(undefined);
        }}
        onCreated={handleAuthCreated}
        editProfile={editTarget}
      />
    </div>
  );
}
