'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubProviderProfileItem, type ProfileEditPayload } from './HubProviderProfileItem';
import { CreateApiKeyProfileSection, ProviderProfilesSummaryCard } from './hub-provider-profiles.sections';
import type { ProviderProfilesResponse } from './hub-provider-profiles.types';
import { ensureBuiltinProviderProfiles, resolveAccountActionId } from './hub-provider-profiles.view';

export function HubProviderProfilesTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ProviderProfilesResponse | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createDisplayName, setCreateDisplayName] = useState('');
  const [createBaseUrl, setCreateBaseUrl] = useState('');
  const [createApiKey, setCreateApiKey] = useState('');
  const [createModels, setCreateModels] = useState<string[]>([]);

  const fetchProfiles = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/api/provider-profiles');
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((body.error as string) ?? '加载失败');
        return;
      }
      const body = (await res.json()) as ProviderProfilesResponse;
      setData(body);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchProfiles();
  }, [fetchProfiles]);

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

  const createProfile = useCallback(async () => {
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
      await callApi('/api/provider-profiles', {
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
      await fetchProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, [callApi, createApiKey, createBaseUrl, createDisplayName, createModels, fetchProfiles]);

  const deleteProfile = useCallback(
    async (profileId: string) => {
      setBusyId(profileId);
      setError(null);
      try {
        await callApi(`/api/provider-profiles/${profileId}`, { method: 'DELETE' });
        await fetchProfiles();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [callApi, fetchProfiles],
  );

  const saveProfile = useCallback(
    async (profileId: string, payload: ProfileEditPayload) => {
      setBusyId(profileId);
      setError(null);
      try {
        await callApi(`/api/provider-profiles/${profileId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        await fetchProfiles();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [callApi, fetchProfiles],
  );

  const displayProfiles = useMemo(() => ensureBuiltinProviderProfiles(data?.providers ?? []), [data?.providers]);
  const builtinProfiles = useMemo(() => displayProfiles.filter((profile) => profile.builtin), [displayProfiles]);
  const customProfiles = useMemo(() => displayProfiles.filter((profile) => !profile.builtin), [displayProfiles]);
  const displayCards = useMemo(() => [...builtinProfiles, ...customProfiles], [builtinProfiles, customProfiles]);

  if (loading) return <p className="text-sm text-gray-400">加载中...</p>;
  if (!data) return <p className="text-sm text-gray-400">暂无数据</p>;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

      <ProviderProfilesSummaryCard />

      <div role="group" aria-label="Provider Profile List" className="space-y-4">
        {displayCards.map((profile) => (
          <HubProviderProfileItem
            key={profile.id}
            profile={profile}
            busy={busyId === resolveAccountActionId(profile)}
            onSave={(_profileId, payload) => saveProfile(resolveAccountActionId(profile), payload)}
            onDelete={() => deleteProfile(resolveAccountActionId(profile))}
          />
        ))}
      </div>

      <CreateApiKeyProfileSection
        displayName={createDisplayName}
        baseUrl={createBaseUrl}
        apiKey={createApiKey}
        models={createModels}
        busy={busyId === 'create'}
        onDisplayNameChange={setCreateDisplayName}
        onBaseUrlChange={setCreateBaseUrl}
        onApiKeyChange={setCreateApiKey}
        onModelsChange={setCreateModels}
        onCreate={createProfile}
      />
      <p className="text-xs leading-5 text-[#B59A88]">
        secrets 存储在 `~/.cat-cafe/provider-profiles.secrets.local.json`（全局），Git 忽略。
      </p>
    </div>
  );
}
