'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubAccountItem, type ProfileEditPayload } from './HubAccountItem';
import { AccountsSummaryCard, CreateApiKeyAccountSection } from './hub-accounts.sections';
import type { AccountsResponse } from './hub-accounts.types';
import { ensureBuiltinAccounts, resolveAccountActionId } from './hub-accounts.view';

export function HubAccountsTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createDisplayName, setCreateDisplayName] = useState('');
  const [createBaseUrl, setCreateBaseUrl] = useState('');
  const [createApiKey, setCreateApiKey] = useState('');
  const [createModels, setCreateModels] = useState<string[]>([]);

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

  const createAccount = useCallback(async () => {
    if (!createDisplayName.trim()) {
      setError('请输入账号显示名');
      return;
    }
    if (!createBaseUrl.trim() || !createApiKey.trim()) {
      setError('API Key 账号需要填写 baseUrl 和 apiKey');
      return;
    }
    setBusyId('create');
    setError(null);
    try {
      await callApi('/api/accounts', {
        method: 'POST',
        body: JSON.stringify({
          displayName: createDisplayName.trim(),
          authType: 'api_key',
          baseUrl: createBaseUrl.trim(),
          apiKey: createApiKey.trim(),
          models: createModels,
        }),
      });
      setCreateDisplayName('');
      setCreateBaseUrl('');
      setCreateApiKey('');
      setCreateModels([]);
      await fetchAccounts();
      window.dispatchEvent(new CustomEvent('accounts-changed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, [callApi, createApiKey, createBaseUrl, createDisplayName, createModels, fetchAccounts]);

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

  const displayAccounts = useMemo(() => ensureBuiltinAccounts(data?.providers ?? []), [data?.providers]);
  const builtinAccounts = useMemo(() => displayAccounts.filter((a) => a.builtin), [displayAccounts]);
  const customAccounts = useMemo(() => displayAccounts.filter((a) => !a.builtin), [displayAccounts]);
  const displayCards = useMemo(() => [...builtinAccounts, ...customAccounts], [builtinAccounts, customAccounts]);

  if (loading) return <p className="text-sm text-cafe-muted">加载中...</p>;
  if (!data) return <p className="text-sm text-cafe-muted">暂无数据</p>;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

      <AccountsSummaryCard />

      <div role="group" aria-label="Account List" className="space-y-4">
        {displayCards.map((account) => (
          <HubAccountItem
            key={account.id}
            profile={account}
            busy={busyId === resolveAccountActionId(account)}
            onSave={(_id, payload) => saveAccount(resolveAccountActionId(account), payload)}
            onDelete={() => deleteAccount(resolveAccountActionId(account))}
          />
        ))}
      </div>

      <CreateApiKeyAccountSection
        displayName={createDisplayName}
        baseUrl={createBaseUrl}
        apiKey={createApiKey}
        models={createModels}
        busy={busyId === 'create'}
        onDisplayNameChange={setCreateDisplayName}
        onBaseUrlChange={setCreateBaseUrl}
        onApiKeyChange={setCreateApiKey}
        onModelsChange={setCreateModels}
        onCreate={createAccount}
      />
      <p className="text-xs leading-5 text-[#B59A88]">
        secrets 存储在 `~/.cat-cafe/credentials.json`（全局），Git 忽略。
      </p>
    </div>
  );
}
