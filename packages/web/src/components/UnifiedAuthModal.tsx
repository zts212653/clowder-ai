'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { BuiltinAccountClient, ProfileAuthType } from './hub-accounts.types';
import { builtinClientLabel } from './hub-accounts.view';
import { TagEditor } from './hub-tag-editor';

const CLIENT_OPTIONS: BuiltinAccountClient[] = ['anthropic', 'openai', 'google', 'kimi', 'dare', 'opencode'];

/** Suggested models per client — kept in sync with cat-template.json clientDefaults. */
const MODEL_SUGGESTIONS: Partial<Record<BuiltinAccountClient, string[]>> = {
  anthropic: [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-6[1m]',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
  ],
  openai: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'],
  google: ['gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview'],
  dare: ['claude-sonnet-4-6'],
  opencode: ['claude-sonnet-4-6', 'claude-opus-4-6'],
};

export interface UnifiedAuthEditData {
  id: string;
  displayName?: string;
  baseUrl?: string;
  clientId?: BuiltinAccountClient;
  authType?: ProfileAuthType;
  models?: string[];
  envVars?: Record<string, string>;
}

type AuthMode = ProfileAuthType;

interface UnifiedAuthModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (profileId: string) => void;
  editProfile?: UnifiedAuthEditData;
  /** When provided, locks client to this value (wizard context). */
  initialClientId?: BuiltinAccountClient;
}

export function UnifiedAuthModal({ open, onClose, onCreated, editProfile, initialClientId }: UnifiedAuthModalProps) {
  const isEdit = Boolean(editProfile);
  const defaultClientId = editProfile?.clientId ?? initialClientId ?? 'anthropic';
  const [authMode, setAuthMode] = useState<AuthMode>(editProfile?.authType === 'api_key' ? 'api_key' : 'oauth');
  const [clientId, setClientId] = useState<BuiltinAccountClient>(defaultClientId);
  const [displayName, setDisplayName] = useState(editProfile?.displayName ?? '');
  const [baseUrl, setBaseUrl] = useState(editProfile?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[]>(editProfile?.models ?? []);
  const [envEntries, setEnvEntries] = useState<Array<{ key: string; value: string }>>(
    editProfile?.envVars ? Object.entries(editProfile.envVars).map(([key, value]) => ({ key, value })) : [],
  );
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(editProfile?.envVars && Object.keys(editProfile.envVars).length > 0),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rehydrate form state when modal re-opens (same key but stale data)
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      const cid = editProfile?.clientId ?? initialClientId ?? 'anthropic';
      setClientId(cid);
      setAuthMode(editProfile?.authType === 'api_key' ? 'api_key' : 'oauth');
      setDisplayName(editProfile?.displayName ?? '');
      setBaseUrl(editProfile?.baseUrl ?? '');
      setModels(editProfile?.models ?? []);
      setApiKey('');
      setError(null);
      setEnvEntries(
        editProfile?.envVars ? Object.entries(editProfile.envVars).map(([key, value]) => ({ key, value })) : [],
      );
      setAdvancedOpen(Boolean(editProfile?.envVars && Object.keys(editProfile.envVars).length > 0));
    }
    prevOpenRef.current = open;
  }, [open, editProfile, initialClientId]);

  if (!open) return null;

  const isOAuth = authMode === 'oauth';

  /** POSIX env var key: must start with uppercase or _, rest alphanumeric + _. */
  const ENV_KEY_RE = /^[A-Z_][A-Za-z0-9_]*$/;
  const isValidEnvKey = (k: string) => ENV_KEY_RE.test(k) && !k.startsWith('CAT_CAFE_');

  /** Build envVars Record from entries, filtering empty/invalid/reserved keys. */
  const buildEnvVars = (): Record<string, string> | undefined => {
    const vars: Record<string, string> = {};
    for (const { key, value } of envEntries) {
      const k = key.trim();
      if (!k || !isValidEnvKey(k)) continue;
      vars[k] = value;
    }
    return Object.keys(vars).length > 0 ? vars : undefined;
  };

  const resetForm = () => {
    setClientId(defaultClientId);
    setAuthMode('oauth');
    setDisplayName('');
    setBaseUrl('');
    setApiKey('');
    setModels([]);
    setEnvEntries([]);
    setAdvancedOpen(false);
    setError(null);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const canSubmit = isOAuth
    ? Boolean(displayName.trim())
    : Boolean(displayName.trim()) && models.length > 0 && (isEdit || Boolean(baseUrl.trim() && apiKey.trim()));

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      if (isEdit) {
        const envVars = buildEnvVars();
        const patch: Record<string, unknown> = {
          displayName: displayName.trim(),
          models,
          envVars: envVars ?? {},
        };
        if (editProfile?.clientId) {
          patch.clientId = clientId;
        }
        if (baseUrl.trim()) patch.baseUrl = baseUrl.trim();
        if (apiKey.trim()) patch.apiKey = apiKey.trim();
        const res = await apiFetch(`/api/accounts/${encodeURIComponent(editProfile!.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `更新失败 (${res.status})`);
        }
        onCreated(editProfile!.id);
        onClose();
      } else if (isOAuth) {
        const effectiveClientId = initialClientId ?? clientId;
        const res = await apiFetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: displayName.trim(),
            authType: 'oauth',
            clientId: effectiveClientId,
            ...(models.length > 0 ? { models } : {}),
            ...(() => {
              const ev = buildEnvVars();
              return ev ? { envVars: ev } : {};
            })(),
          }),
        });
        const body = (await res.json()) as { profile?: { id?: string }; error?: string };
        if (!res.ok) throw new Error(body.error ?? `创建失败 (${res.status})`);
        if (body.profile?.id) {
          resetForm();
          onCreated(body.profile.id);
          onClose();
        }
      } else {
        const res = await apiFetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: displayName.trim(),
            authType: 'api_key',
            ...(initialClientId ? { clientId: initialClientId } : {}),
            baseUrl: baseUrl.trim(),
            apiKey: apiKey.trim(),
            models,
            ...(() => {
              const ev = buildEnvVars();
              return ev ? { envVars: ev } : {};
            })(),
          }),
        });
        const body = (await res.json()) as { profile?: { id?: string }; error?: string };
        if (!res.ok) throw new Error(body.error ?? `创建失败 (${res.status})`);
        if (body.profile?.id) {
          resetForm();
          onCreated(body.profile.id);
          onClose();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 px-4" onClick={handleClose}>
      <div
        className="w-full max-w-md rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-1 flex justify-end">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full p-1 text-[#C4B5A8] hover:bg-[#F5EDE6] hover:text-[#8A776B]"
            aria-label="关闭"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="mb-1 text-[11px] text-[#B59A88]">{isEdit ? '编辑账户' : '系统配置 > 账户配置 > 添加认证'}</p>
        <h4 className="mb-4 text-base font-semibold text-[#5C4D42]">{isEdit ? '编辑账户认证' : '添加账户认证'}</h4>

        {/* Mode toggle */}
        <div className={`mb-4 flex rounded-lg border border-[#E8DCCF] p-0.5 ${isEdit ? 'opacity-50' : ''}`}>
          <button
            type="button"
            onClick={() => !isEdit && setAuthMode('oauth')}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${
              isOAuth ? 'bg-[#D49266] text-white shadow-sm' : 'text-[#8A776B]'
            } ${isEdit ? 'cursor-not-allowed' : !isOAuth ? 'hover:bg-[#F5EDE6]' : ''}`}
            disabled={isEdit}
          >
            OAuth
          </button>
          <button
            type="button"
            onClick={() => !isEdit && setAuthMode('api_key')}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${
              !isOAuth ? 'bg-[#D49266] text-white shadow-sm' : 'text-[#8A776B]'
            } ${isEdit ? 'cursor-not-allowed' : isOAuth ? 'hover:bg-[#F5EDE6]' : ''}`}
            disabled={isEdit}
          >
            API Key
          </button>
        </div>

        <div className="space-y-3" data-guide-id="accounts.create-details">
          {/* 账号名称 — always shown */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[#8A776B]">账号名称</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="例如: my-claude-account"
              className="w-full rounded-lg border border-[#E8DCCF] bg-white px-3 py-2 text-sm placeholder:text-[#C4B5A8]"
            />
          </div>

          {/* OAuth mode: Client dropdown */}
          {isOAuth && (
            <div>
              <label className="mb-1 block text-xs font-medium text-[#8A776B]">Client</label>
              {initialClientId ? (
                <p className="w-full rounded-lg border border-[#E8DCCF] bg-[#FAF7F4] px-3 py-2 text-sm text-[#5C4D42]">
                  {builtinClientLabel(initialClientId)}
                </p>
              ) : (
                <select
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value as BuiltinAccountClient)}
                  className="w-full rounded-lg border border-[#E8DCCF] bg-white px-3 py-2 text-sm text-[#5C4D42]"
                >
                  {CLIENT_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {builtinClientLabel(c)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* API Key mode: Base URL + API Key */}
          {!isOAuth && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-[#8A776B]">API 服务地址 (Base URL)</label>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="w-full rounded-lg border border-[#E8DCCF] bg-white px-3 py-2 text-sm placeholder:text-[#C4B5A8]"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[#8A776B]">
                  API Key{isEdit && '（留空保持不变）'}
                </label>
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setError(null);
                  }}
                  placeholder={isEdit ? '••••••••••••' : 'sk-...'}
                  className="w-full rounded-lg border border-[#E8DCCF] bg-white px-3 py-2 text-sm placeholder:text-[#C4B5A8]"
                />
              </div>
            </>
          )}

          {/* 可用模型 */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[#8A776B]">可用模型</label>
            <TagEditor
              tags={models}
              tone="purple"
              addLabel="+ 添加"
              placeholder="输入模型名"
              emptyLabel={isOAuth ? '(可选，留空使用默认模型)' : '(至少添加 1 个模型)'}
              onChange={setModels}
              minCount={0}
            />
            {/* Model suggestions for builtin clients */}
            {isOAuth &&
              (MODEL_SUGGESTIONS[initialClientId ?? clientId] ?? []).filter((m) => !models.includes(m)).length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-[#B59A88]">推荐</span>
                  {(MODEL_SUGGESTIONS[initialClientId ?? clientId] ?? [])
                    .filter((m) => !models.includes(m))
                    .map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setModels([...models, m])}
                        className="rounded-full border border-dashed border-[#D4C4B5] px-2 py-0.5 text-[10px] text-[#8A776B] transition hover:border-[#D49266] hover:text-[#D49266]"
                      >
                        + {m}
                      </button>
                    ))}
                </div>
              )}
          </div>

          {/* F171: 高级配置 — collapsible env var injection */}
          <div className="rounded-lg border border-[#E8DCCF]">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center gap-1 px-3 py-2 text-xs font-medium text-[#8A776B] hover:bg-[#FAF7F4]"
            >
              <span className="text-[10px]">{advancedOpen ? '\u25BE' : '\u25B8'}</span>
              高级配置 (可选)
            </button>
            {advancedOpen && (
              <div className="border-t border-[#E8DCCF] px-3 pb-3 pt-2">
                <p className="mb-2 text-[10px] text-[#B59A88]">
                  自定义环境变量，启动 agent 时注入子进程 (CAT_CAFE_ 前缀为保留变量)
                </p>
                <div className="space-y-1.5">
                  {envEntries.map((entry, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input
                        value={entry.key}
                        onChange={(e) => {
                          const next = [...envEntries];
                          next[i] = { ...next[i], key: e.target.value };
                          setEnvEntries(next);
                        }}
                        placeholder="KEY"
                        className={`w-[38%] rounded border px-2 py-1 font-mono text-xs placeholder:text-[#C4B5A8] ${
                          entry.key.trim() && !isValidEnvKey(entry.key.trim())
                            ? 'border-red-300 bg-red-50 text-red-600'
                            : 'border-[#E8DCCF] bg-white text-[#5C4D42]'
                        }`}
                      />
                      <span className="text-[10px] text-[#C4B5A8]">=</span>
                      <input
                        value={entry.value}
                        onChange={(e) => {
                          const next = [...envEntries];
                          next[i] = { ...next[i], value: e.target.value };
                          setEnvEntries(next);
                        }}
                        placeholder="value"
                        className="flex-1 rounded border border-[#E8DCCF] bg-white px-2 py-1 font-mono text-xs text-[#5C4D42] placeholder:text-[#C4B5A8]"
                      />
                      <button
                        type="button"
                        onClick={() => setEnvEntries(envEntries.filter((_, j) => j !== i))}
                        className="text-xs text-[#C4B5A8] hover:text-red-400"
                        title="删除"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                  {envEntries.some((e) => e.key.trim() && !isValidEnvKey(e.key.trim())) && (
                    <p className="text-[10px] text-red-500">
                      {envEntries.some((e) => e.key.trim().startsWith('CAT_CAFE_')) ? 'CAT_CAFE_ 前缀为系统保留；' : ''}
                      变量名须以大写字母或下划线开头，仅含 A-Z、0-9、_
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setEnvEntries([...envEntries, { key: '', value: '' }])}
                  className="mt-2 text-[10px] font-medium text-[#D49266] hover:text-[#c47f52]"
                >
                  + 添加变量
                </button>
              </div>
            )}
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}

        {/* Save button — bottom right */}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            data-guide-id="accounts.create-submit"
            onClick={handleSubmit}
            disabled={saving || !canSubmit}
            className="rounded-lg bg-[#D49266] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#c47f52] disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
