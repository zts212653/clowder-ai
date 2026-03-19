'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { HubProviderProfileItem, type ProfileEditPayload } from './HubProviderProfileItem';
import {
  CreateApiKeyProfileSection,
  ProviderFilterTabs,
  ProviderProfilesSummaryCard,
  type ProviderFilterKey,
} from './hub-provider-profiles.sections';
import { expandProviderProfiles, isOAuthLikeBuiltin, resolveProfileActionId } from './hub-provider-profiles.view';
import type {
  ProfileItem,
  ProfileProtocol,
  ProfileTestResult,
  ProviderProfilesResponse,
} from './hub-provider-profiles.types';
import { getProjectPaths, projectDisplayName } from './ThreadSidebar/thread-utils';

export function HubProviderProfilesTab() {
  const threads = useChatStore((s) => s.threads);
  const knownProjects = useMemo(() => getProjectPaths(threads), [threads]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ProviderProfilesResponse | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testResultById, setTestResultById] = useState<Record<string, ProfileTestResult>>({});
  const [filter, setFilter] = useState<ProviderFilterKey>('all');

  const [createDisplayName, setCreateDisplayName] = useState('');
  const [createProtocol, setCreateProtocol] = useState<ProfileProtocol>('openai');
  const [createBaseUrl, setCreateBaseUrl] = useState('');
  const [createApiKey, setCreateApiKey] = useState('');
  const [createModels, setCreateModels] = useState<string[]>([]);

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
    fetchProfiles();
  }, [fetchProfiles]);

  const switchProject = useCallback(
    (nextPath: string | null) => {
      setProjectPath(nextPath);
      setLoading(true);
      fetchProfiles(nextPath ?? undefined);
    },
    [fetchProfiles],
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
    await fetchProfiles(projectPath ?? undefined);
  }, [fetchProfiles, projectPath]);

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
          projectPath: projectPath ?? undefined,
          displayName: createDisplayName.trim(),
          authType: 'api_key',
          protocol: createProtocol,
          baseUrl: createBaseUrl.trim(),
          apiKey: createApiKey.trim(),
          ...(createModels.length > 0 ? { models: createModels } : {}),
          setActive: true,
        }),
      });
      setCreateDisplayName('');
      setCreateProtocol('openai');
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
    projectPath,
    refresh,
  ]);

  const activateProfile = useCallback(
    async (profileId: string) => {
      setBusyId(profileId);
      setError(null);
      try {
        await callApi(`/api/provider-profiles/${profileId}/activate`, {
          method: 'POST',
          body: JSON.stringify({
            projectPath: projectPath ?? undefined,
          }),
        });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [callApi, projectPath, refresh],
  );

  const deleteProfile = useCallback(
    async (profileId: string) => {
      setBusyId(profileId);
      setError(null);
      try {
        await callApi(`/api/provider-profiles/${profileId}`, {
          method: 'DELETE',
          body: JSON.stringify({
            projectPath: projectPath ?? undefined,
          }),
        });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [callApi, projectPath, refresh],
  );

  const saveProfile = useCallback(
    async (profileId: string, payload: ProfileEditPayload) => {
      setBusyId(profileId);
      setError(null);
      try {
        await callApi(`/api/provider-profiles/${profileId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            projectPath: projectPath ?? undefined,
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
    [callApi, projectPath, refresh],
  );

  const testProfile = useCallback(
    async (profileId: string) => {
      setBusyId(profileId);
      setError(null);
      try {
        const body = (await callApi(`/api/provider-profiles/${profileId}/test`, {
          method: 'POST',
          body: JSON.stringify({
            projectPath: projectPath ?? undefined,
          }),
        })) as unknown as ProfileTestResult;
        setTestResultById((prev) => ({ ...prev, [profileId]: body }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [callApi, projectPath],
  );

  const allPaths = useMemo(() => {
    const paths = new Set<string>();
    if (data?.projectPath) paths.add(data.projectPath);
    for (const p of knownProjects) paths.add(p);
    return [...paths].map((path) => ({ path, label: projectDisplayName(path) }));
  }, [data?.projectPath, knownProjects]);

  const displayProfiles = useMemo(() => expandProviderProfiles(data?.providers ?? []), [data?.providers]);
  const builtinProfiles = useMemo(() => displayProfiles.filter((profile) => profile.builtin), [displayProfiles]);
  const customProfiles = useMemo(() => displayProfiles.filter((profile) => !profile.builtin), [displayProfiles]);
  const filteredBuiltinProfiles = useMemo(() => {
    if (filter === 'all' || filter === 'api_key') return filter === 'all' ? builtinProfiles : [];
    return builtinProfiles.filter((profile) => profile.protocol === filter && !profile.oauthLikeClient);
  }, [builtinProfiles, filter]);
  const filteredCustomProfiles = useMemo(() => {
    if (filter === 'all' || filter === 'api_key') return customProfiles;
    return [];
  }, [customProfiles, filter]);
  const isProfileActive = useCallback(
    (profile: ProfileItem) => {
      if (!data) return false;
      const protocolActive = data.activeProfileIds?.[profile.protocol];
      const targetProfileId = resolveProfileActionId(profile);
      if (protocolActive !== undefined) return protocolActive === targetProfileId;
      return data.activeProfileId === targetProfileId;
    },
    [data],
  );

  if (loading) return <p className="text-sm text-gray-400">加载中...</p>;
  if (!data) return <p className="text-sm text-gray-400">暂无数据</p>;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

      <ProviderProfilesSummaryCard
        projectLabel={projectDisplayName(data.projectPath)}
        allPaths={allPaths}
        activePath={projectPath}
        onSwitchProject={switchProject}
      />
      <ProviderFilterTabs value={filter} onChange={setFilter} />

      <div aria-label="Provider Profile List" className="space-y-4">
        {filteredBuiltinProfiles.length > 0 ? (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-gray-700">内置认证</h4>
              <span className="text-[11px] text-gray-400">{filteredBuiltinProfiles.length} 项</span>
            </div>
            <div className="space-y-2">
              {filteredBuiltinProfiles.map((profile) => (
                <HubProviderProfileItem
                  key={profile.id}
                  profile={profile}
                  isActive={isOAuthLikeBuiltin(profile) ? false : isProfileActive(profile)}
                  busy={busyId === resolveProfileActionId(profile)}
                  testResult={testResultById[resolveProfileActionId(profile)]}
                  onActivate={() => activateProfile(resolveProfileActionId(profile))}
                  onSave={(_profileId, payload) => saveProfile(resolveProfileActionId(profile), payload)}
                  onTest={() => testProfile(resolveProfileActionId(profile))}
                  onDelete={() => deleteProfile(resolveProfileActionId(profile))}
                />
              ))}
            </div>
          </section>
        ) : null}

        {filter === 'all' || filter === 'api_key' ? (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-gray-700">自定义 API Key 账号</h4>
              <span className="text-[11px] text-gray-400">{filteredCustomProfiles.length} 项</span>
            </div>
            <div className="space-y-2">
              {filteredCustomProfiles.length === 0 ? <p className="text-xs text-gray-400">暂未创建自定义 API Key 账号</p> : null}
              {filteredCustomProfiles.map((profile) => (
                <HubProviderProfileItem
                  key={profile.id}
                  profile={profile}
                  isActive={isProfileActive(profile)}
                  busy={busyId === resolveProfileActionId(profile)}
                  testResult={testResultById[resolveProfileActionId(profile)]}
                  onActivate={activateProfile}
                  onSave={saveProfile}
                  onTest={testProfile}
                  onDelete={deleteProfile}
                />
              ))}
            </div>
          </section>
        ) : null}
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
    </div>
  );
}
