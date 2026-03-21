'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { HubProviderProfileItem, type ProfileEditPayload } from './HubProviderProfileItem';
import { CreateApiKeyProfileSection, ProviderProfilesSummaryCard } from './hub-provider-profiles.sections';
import type { ProviderProfilesResponse } from './hub-provider-profiles.types';
import { ensureBuiltinProviderProfiles, resolveAccountActionId } from './hub-provider-profiles.view';
import { getProjectPaths, projectDisplayName } from './ThreadSidebar/thread-utils';

export function HubProviderProfilesTab() {
  const threads = useChatStore((s) => s.threads);
  const currentProjectPath = useChatStore((s) => s.currentProjectPath);
  const knownProjects = useMemo(() => getProjectPaths(threads), [threads]);
  const threadProjectPath = currentProjectPath && currentProjectPath !== 'default' ? currentProjectPath : null;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ProviderProfilesResponse | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createDisplayName, setCreateDisplayName] = useState('');
  const [createProtocol, setCreateProtocol] = useState<'anthropic' | 'openai' | 'google'>('anthropic');
  const [createBaseUrl, setCreateBaseUrl] = useState('');
  const [createApiKey, setCreateApiKey] = useState('');
  const [createModels, setCreateModels] = useState<string[]>([]);
  const requestProjectPath = projectPath ?? threadProjectPath;
  const mutationProjectPath = projectPath ?? data?.projectPath ?? threadProjectPath;

  const fetchProfiles = useCallback(async (forProject?: string) => {
    setError(null);
    try {
      const query = new URLSearchParams();
      if (forProject) query.set('projectPath', forProject);
      const res = await apiFetch(`/api/provider-profiles?${query.toString()}`);
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
    fetchProfiles(requestProjectPath ?? undefined);
  }, [fetchProfiles, requestProjectPath]);

  const switchProject = useCallback(
    (nextPath: string | null) => {
      setProjectPath(nextPath);
      setLoading(true);
      fetchProfiles(nextPath ?? threadProjectPath ?? undefined);
    },
    [fetchProfiles, threadProjectPath],
  );

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

  const refresh = useCallback(async () => {
    await fetchProfiles(mutationProjectPath ?? undefined);
  }, [fetchProfiles, mutationProjectPath]);

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
          projectPath: mutationProjectPath ?? undefined,
          displayName: createDisplayName.trim(),
          authType: 'api_key',
          protocol: createProtocol,
          baseUrl: createBaseUrl.trim(),
          apiKey: createApiKey.trim(),
          models: createModels,
        }),
      });
      setCreateDisplayName('');
      setCreateProtocol('anthropic');
      setCreateBaseUrl('');
      setCreateApiKey('');
      setCreateModels([]);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }, [
    callApi,
    createApiKey,
    createBaseUrl,
    createDisplayName,
    createModels,
    createProtocol,
    mutationProjectPath,
    refresh,
  ]);

  const deleteProfile = useCallback(
    async (profileId: string) => {
      setBusyId(profileId);
      setError(null);
      try {
        await callApi(`/api/provider-profiles/${profileId}`, {
          method: 'DELETE',
          body: JSON.stringify({
            projectPath: mutationProjectPath ?? undefined,
          }),
        });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [callApi, mutationProjectPath, refresh],
  );

  const saveProfile = useCallback(
    async (profileId: string, payload: ProfileEditPayload) => {
      setBusyId(profileId);
      setError(null);
      try {
        await callApi(`/api/provider-profiles/${profileId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            projectPath: mutationProjectPath ?? undefined,
            ...payload,
          }),
        });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [callApi, mutationProjectPath, refresh],
  );

  const allPaths = useMemo(() => {
    const paths = new Set<string>();
    if (data?.projectPath) paths.add(data.projectPath);
    if (threadProjectPath) paths.add(threadProjectPath);
    for (const p of knownProjects) paths.add(p);
    return [...paths].map((path) => ({ path, label: projectDisplayName(path) }));
  }, [data?.projectPath, knownProjects, threadProjectPath]);

  const displayProfiles = useMemo(() => ensureBuiltinProviderProfiles(data?.providers ?? []), [data?.providers]);
  const builtinProfiles = useMemo(() => displayProfiles.filter((profile) => profile.builtin), [displayProfiles]);
  const customProfiles = useMemo(() => displayProfiles.filter((profile) => !profile.builtin), [displayProfiles]);
  const displayCards = useMemo(() => [...builtinProfiles, ...customProfiles], [builtinProfiles, customProfiles]);

  if (loading) return <p className="text-sm text-gray-400">加载中...</p>;
  if (!data) return <p className="text-sm text-gray-400">暂无数据</p>;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

      <ProviderProfilesSummaryCard
        projectLabel={projectDisplayName(data.projectPath)}
        allPaths={allPaths}
        activePath={mutationProjectPath}
        onSwitchProject={switchProject}
      />

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
        protocol={createProtocol}
        baseUrl={createBaseUrl}
        apiKey={createApiKey}
        models={createModels}
        busy={busyId === 'create'}
        onDisplayNameChange={setCreateDisplayName}
        onProtocolChange={setCreateProtocol}
        onBaseUrlChange={setCreateBaseUrl}
        onApiKeyChange={setCreateApiKey}
        onModelsChange={setCreateModels}
        onCreate={createProfile}
      />
      <p className="text-xs leading-5 text-[#B59A88]">
        secrets 存储在 `.cat-cafe/provider-profiles.secrets.local.json`，Git 忽略。
      </p>
    </div>
  );
}
