'use client';

import { type ClientDefaultsEntry, type ClientId, resolveClientDefaults } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { AccountsResponse, ProfileItem } from '../hub-accounts.types';
import { resolveScopedDefaultModel } from '../hub-cat-editor.client-scope';
import { builtinAccountIdForClient, type ClientValue, filterAccounts } from '../hub-cat-editor.model';
import { type UnifiedAuthEditData, UnifiedAuthModal } from '../UnifiedAuthModal';
import { ProfileCard } from './ProfileCard';

interface ConfigStepProps {
  client: string;
  /** Account provider key (anthropic/openai/google) — distinct from model provider. */
  clientId: string;
  onComplete: (config: { accountRef: string; model: string }) => void;
}

/** Map raw API error messages to user-friendly Chinese */
function humanizeError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized')) return 'Key 好像不对？请检查是否有多余空格或已过期';
  if (lower.includes('403') || lower.includes('forbidden')) return 'Key 权限不足，请确认已开通 API 访问';
  if (lower.includes('429') || lower.includes('rate')) return '请求太频繁，请稍后再试';
  if (lower.includes('timeout') || lower.includes('超时')) return '连接超时，请检查网络';
  if (lower.includes('fetch') || lower.includes('network') || lower.includes('网络')) return '网络错误，请检查连接';
  return msg;
}

export function ConfigStep({ client, clientId, onComplete }: ConfigStepProps) {
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  /**
   * #768: the per-client default menu from `cat-template.json`. An account that publishes
   * no model list (an API-key profile without a catalog, a builtin whose catalog fetch
   * failed) used to dead-end this step: "创建猫猫" waits on a connectivity test, the test
   * waits on a model, and the only way out was inventing a model id and persisting it onto
   * the account. The member editor already reads this same endpoint for the same reason —
   * fetched here rather than threaded through the wizard because the menu is keyed by the
   * client chosen in the previous step, not by the role template.
   */
  const [clientDefaults, setClientDefaults] = useState<Readonly<Record<string, ClientDefaultsEntry>>>({});
  const [loading, setLoading] = useState(true);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [expandedId, setExpandedId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editProfile, setEditProfile] = useState<UnifiedAuthEditData | undefined>();
  const testSigRef = useRef('');
  const testCacheRef = useRef<Map<string, { ok: boolean; message?: string }>>(new Map());

  const fetchProfiles = useCallback(async () => {
    const res = await apiFetch('/api/accounts');
    if (!res.ok) return [];
    const body = (await res.json()) as AccountsResponse;
    const providers = body.providers ?? [];
    setProfiles(providers);
    return providers;
  }, []);

  useEffect(() => {
    fetchProfiles()
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fetchProfiles]);

  // #768: template defaults are an enhancement, never a gate — a failure here leaves the
  // step exactly as it was, so `loading` stays tied to the accounts call alone.
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/cat-templates')
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as { clientDefaults?: Record<string, ClientDefaultsEntry> };
      })
      .then((body) => {
        if (!cancelled && body) setClientDefaults(body.clientDefaults ?? {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const available = useMemo(() => filterAccounts(clientId as ClientValue, profiles), [clientId, profiles]);

  const templateDefaults = useMemo(
    () => resolveClientDefaults(clientDefaults, clientId as ClientId),
    [clientDefaults, clientId],
  );
  /** #768: only offered while the account itself lists nothing, so it never shadows a catalog. */
  const suggestedModels = useMemo(() => templateDefaults?.models ?? [], [templateDefaults]);

  /**
   * #768: the model this account resolves to — the same precedence the member editor
   * applies (`resolveScopedDefaultModel`), so the two creation surfaces cannot drift:
   * the account's own list first, the template default only when it has none.
   */
  const resolveModel = useCallback(
    (p?: ProfileItem) =>
      resolveScopedDefaultModel({
        currentModel: '',
        accountModels: p?.models?.filter(Boolean) ?? [],
        templateDefaultModel: templateDefaults?.defaultModel,
        scopeChanged: true,
      }) ?? '',
    [templateDefaults],
  );

  useEffect(() => {
    if (!selectedProfileId && available.length > 0) {
      const defaultId = builtinAccountIdForClient(clientId as ClientValue) ?? available[0]?.id ?? '';
      setSelectedProfileId(defaultId);
      setExpandedId(defaultId);
      setSelectedModel(resolveModel(available.find((p) => p.id === defaultId)));
    }
  }, [available, clientId, resolveModel, selectedProfileId]);

  // #768: the two fetches race, so the account may be selected before the template menu
  // lands. Fill only a still-empty field — whatever the user picked in between outranks it.
  useEffect(() => {
    if (!selectedProfileId) return;
    setSelectedModel((prev) => prev || resolveModel(available.find((p) => p.id === selectedProfileId)));
  }, [available, resolveModel, selectedProfileId]);

  const handleSelectProfile = (id: string) => {
    const collapse = expandedId === id && selectedProfileId === id;
    setSelectedProfileId(id);
    setExpandedId(collapse ? '' : id);
    const model = resolveModel(available.find((p) => p.id === id));
    setSelectedModel(model);
    testSigRef.current = '';
    setTesting(false);
    setTestResult(testCacheRef.current.get(`${id}:${model}`) ?? null);
  };

  const handleModelSelect = (m: string) => {
    setSelectedModel(m);
    testSigRef.current = '';
    setTesting(false);
    setTestResult(testCacheRef.current.get(`${selectedProfileId}:${m}`) ?? null);
  };

  const handleTest = async () => {
    if (!selectedProfileId || !selectedModel) return;
    const sig = `${selectedProfileId}:${selectedModel}`;
    testSigRef.current = sig;
    setTesting(true);
    setTestResult(null);
    try {
      const selectedProfile = available.find((p) => p.id === selectedProfileId);
      const profileClientId = selectedProfile?.provider ?? clientId;
      const res = await apiFetch('/api/first-run/connectivity-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: selectedProfileId,
          clientId: profileClientId,
          client,
          model: selectedModel || undefined,
        }),
      });
      if (testSigRef.current !== sig) return;
      const body = (await res.json()) as { ok: boolean; message?: string; error?: string };
      const result = {
        ok: body.ok,
        message: body.ok ? (body.message ?? '连接成功！') : humanizeError(body.error ?? body.message ?? '连接失败'),
      };
      if (result.ok) testCacheRef.current.set(sig, result);
      setTestResult(result);
    } catch {
      if (testSigRef.current !== sig) return;
      setTestResult({ ok: false, message: '网络错误，请检查连接' });
    } finally {
      if (testSigRef.current === sig) setTesting(false);
    }
  };

  const invalidateCacheForProfile = useCallback((profileId: string) => {
    for (const key of testCacheRef.current.keys()) {
      if (key.startsWith(`${profileId}:`)) testCacheRef.current.delete(key);
    }
    if (testSigRef.current.startsWith(`${profileId}:`)) testSigRef.current = '';
  }, []);

  const handleProfileCreated = useCallback(
    async (newProfileId: string) => {
      invalidateCacheForProfile(newProfileId);
      setTestResult(null);
      const updated = await fetchProfiles();
      setSelectedProfileId(newProfileId);
      setExpandedId(newProfileId);
      setSelectedModel(resolveModel(updated.find((p) => p.id === newProfileId)));
    },
    [fetchProfiles, invalidateCacheForProfile, resolveModel],
  );

  const handleProfileRefresh = useCallback(async () => {
    invalidateCacheForProfile(selectedProfileId);
    setTestResult(null);
    const updated = await fetchProfiles();
    const profile = updated.find((p) => p.id === selectedProfileId);
    const models = profile?.models?.filter(Boolean) ?? [];
    // #768: a template-supplied model stays valid exactly as long as the account keeps
    // publishing no catalog of its own; once it does, that catalog decides again.
    const stillValid = models.length > 0 ? models.includes(selectedModel) : suggestedModels.includes(selectedModel);
    if (selectedModel && !stillValid) {
      setSelectedModel(resolveModel(profile));
    }
  }, [fetchProfiles, invalidateCacheForProfile, resolveModel, selectedProfileId, selectedModel, suggestedModels]);

  if (loading) {
    return <p className="py-8 text-center text-sm text-cafe-muted">加载认证配置...</p>;
  }

  const canProceed = selectedProfileId && selectedModel && testResult?.ok;

  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold text-cafe-secondary">认证和模型配置</h4>
      <p className="mb-3 text-xs text-cafe-muted">选择账号，配置模型，验证连通性</p>

      <div className="scrollbar-cafe mb-3 max-h-80 space-y-1.5 overflow-y-auto">
        {available.length === 0 && (
          <div className="rounded-lg border border-conn-amber-ring bg-conn-amber-bg p-4 text-center text-sm text-conn-amber-text">
            未找到可用账号，请点击下方新建一个账号认证
          </div>
        )}
        {available.map((p) => (
          <ProfileCard
            key={p.id}
            profile={p}
            isSelected={selectedProfileId === p.id}
            isExpanded={expandedId === p.id && selectedProfileId === p.id}
            selectedModel={selectedProfileId === p.id ? selectedModel : ''}
            suggestedModels={suggestedModels}
            testing={selectedProfileId === p.id && testing}
            testResult={selectedProfileId === p.id ? testResult : null}
            onSelect={() => handleSelectProfile(p.id)}
            onModelSelect={handleModelSelect}
            onTest={handleTest}
            onProfileRefresh={handleProfileRefresh}
            onEdit={() => {
              setEditProfile({
                id: p.id,
                displayName: p.displayName ?? p.name,
                baseUrl: p.baseUrl,
                clientId: p.clientId,
                authType: p.authType,
                models: p.models?.filter(Boolean),
                envVars: p.envVars,
              });
              setShowModal(true);
            }}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => {
          setEditProfile(undefined);
          setShowModal(true);
        }}
        className="mb-3 text-xs font-medium text-conn-amber-text hover:text-conn-amber-text"
      >
        + 新建账号认证
      </button>

      <button
        type="button"
        disabled={!canProceed}
        onClick={() => onComplete({ accountRef: selectedProfileId, model: selectedModel })}
        className={`w-full rounded-lg py-2.5 text-sm font-semibold transition ${
          canProceed
            ? 'bg-[var(--semantic-warning)] text-[var(--cafe-surface)] hover:opacity-90'
            : 'cursor-not-allowed bg-cafe-surface text-cafe-muted'
        }`}
      >
        {canProceed ? '创建猫猫' : '请先完成连接测试'}
      </button>

      <UnifiedAuthModal
        key={editProfile?.id ?? 'create'}
        open={showModal}
        onClose={() => {
          setShowModal(false);
          setEditProfile(undefined);
        }}
        onCreated={handleProfileCreated}
        editProfile={editProfile}
        initialClientId={clientId as 'anthropic' | 'openai' | 'google' | 'kimi' | 'opencode'}
      />
    </div>
  );
}
