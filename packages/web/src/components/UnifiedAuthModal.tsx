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

  const titleLabel = isEdit
    ? `编辑账户认证 / ${isOAuth ? 'OAuth' : 'API Key'}`
    : `添加账户认证 / ${isOAuth ? 'OAuth' : 'API Key'}`;

  const fieldInputClass =
    'w-full rounded-lg border border-transparent bg-[var(--console-field-bg)] px-3 h-9 text-compact text-cafe outline-none placeholder:text-cafe-muted transition focus:border-cafe-accent focus:ring-2 focus:ring-cafe-accent/30';

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[var(--console-overlay-medium)] px-4"
      onClick={handleClose}
    >
      <div
        className="flex w-full max-w-[580px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] px-6 py-4 shadow-[0_22px_48px_rgba(43,33,26,0.13)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-4">
          <p className="text-compact font-bold text-[var(--console-modal-title)]">{titleLabel}</p>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleClose}
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--console-modal-close-bg)] text-lg font-extrabold leading-none text-[var(--console-modal-close-fg)]"
          >
            &times;
          </button>
        </div>

        {/* Auth type toggle */}
        <div
          className={`mt-3 flex items-center gap-1 rounded-xl bg-[var(--console-field-bg)] p-1 ${isEdit ? 'opacity-50' : ''}`}
        >
          <button
            type="button"
            onClick={() => !isEdit && setAuthMode('oauth')}
            className={`flex h-8 flex-1 items-center justify-center rounded-lg text-xs font-bold transition ${
              isOAuth ? 'bg-[var(--cafe-accent)] text-[var(--cafe-surface)]' : 'text-cafe-secondary hover:text-cafe'
            } ${isEdit ? 'cursor-not-allowed' : ''}`}
            disabled={isEdit}
          >
            OAuth
          </button>
          <button
            type="button"
            onClick={() => !isEdit && setAuthMode('api_key')}
            className={`flex h-8 flex-1 items-center justify-center rounded-lg text-xs font-bold transition ${
              !isOAuth ? 'bg-[var(--cafe-accent)] text-[var(--cafe-surface)]' : 'text-cafe-secondary hover:text-cafe'
            } ${isEdit ? 'cursor-not-allowed' : ''}`}
            disabled={isEdit}
          >
            API Key
          </button>
        </div>

        <div className="mt-3 space-y-3.5" data-guide-id="accounts.create-details">
          {/* 账号名称 */}
          <div className="space-y-1.5">
            <label className="block text-xs font-bold text-cafe-secondary">账号名称</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="例如: my-claude-account"
              className={fieldInputClass}
            />
          </div>

          {/* OAuth mode: Client dropdown */}
          {isOAuth && (
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-cafe-secondary">Client</label>
              {initialClientId ? (
                <p className={fieldInputClass}>{builtinClientLabel(initialClientId)}</p>
              ) : (
                <select
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value as BuiltinAccountClient)}
                  className={fieldInputClass}
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
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-cafe-secondary">API 服务地址 (Base URL)</label>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className={fieldInputClass}
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-bold text-cafe-secondary">
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
                  className={fieldInputClass}
                />
              </div>
            </>
          )}

          {/* 可用模型 */}
          <div className="space-y-1.5">
            <label className="block text-xs font-bold text-cafe-secondary">可用模型</label>
            <TagEditor
              tags={models}
              tone="purple"
              addLabel="+ 添加"
              placeholder="输入模型名"
              emptyLabel={isOAuth ? '' : '(至少添加 1 个模型)'}
              onChange={setModels}
              minCount={0}
            />
            {(MODEL_SUGGESTIONS[initialClientId ?? clientId] ?? []).filter((m) => !models.includes(m)).length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-label text-cafe-secondary">推荐</span>
                {(MODEL_SUGGESTIONS[initialClientId ?? clientId] ?? [])
                  .filter((m) => !models.includes(m))
                  .map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setModels([...models, m])}
                      className="rounded-full bg-[var(--console-field-bg)] px-2.5 py-0.5 text-label text-cafe-muted transition hover:text-cafe-accent"
                    >
                      + {m}
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* F171: 高级配置 — collapsible env var injection */}
          <div className="rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-3">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex items-center text-compact font-bold text-cafe-secondary"
            >
              <span className="mr-1 text-label">{advancedOpen ? '\u25BE' : '\u25B8'}</span>
              高级配置（可选）
            </button>
            {advancedOpen && (
              <div className="px-3 pb-3 pt-2">
                <p className="mb-2 text-xs font-bold text-[var(--console-advanced-hint)]">
                  自定义环境变量，启动 agent 时注入子进程（CAT_CAFE_ 前缀为保留变量）
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
                        className={`w-[38%] rounded-[10px] border border-transparent px-3 py-1.5 font-mono text-xs outline-none placeholder:text-cafe-muted ${
                          entry.key.trim() && !isValidEnvKey(entry.key.trim())
                            ? 'border-conn-red-ring bg-conn-red-bg text-conn-red-text'
                            : 'bg-[var(--console-field-bg)] text-cafe'
                        }`}
                      />
                      <span className="text-label font-bold text-cafe-muted">=</span>
                      <input
                        value={entry.value}
                        onChange={(e) => {
                          const next = [...envEntries];
                          next[i] = { ...next[i], value: e.target.value };
                          setEnvEntries(next);
                        }}
                        placeholder="value"
                        className="flex-1 rounded-[10px] border border-transparent bg-[var(--console-field-bg)] px-3 py-1.5 font-mono text-xs text-cafe outline-none placeholder:text-cafe-muted"
                      />
                      <button
                        type="button"
                        onClick={() => setEnvEntries(envEntries.filter((_, j) => j !== i))}
                        className="text-xs text-cafe-muted hover:text-conn-red-text"
                        title="删除"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                  {envEntries.some((e) => e.key.trim() && !isValidEnvKey(e.key.trim())) && (
                    <p className="text-caption text-conn-red-text">
                      {envEntries.some((e) => e.key.trim().startsWith('CAT_CAFE_')) ? 'CAT_CAFE_ 前缀为系统保留；' : ''}
                      变量名须以大写字母或下划线开头，仅含 A-Z、0-9、_
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setEnvEntries([...envEntries, { key: '', value: '' }])}
                  className="mt-2 text-xs font-bold text-[var(--cafe-accent)] hover:opacity-80"
                >
                  + 添加变量
                </button>
              </div>
            )}
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-conn-red-text">{error}</p>}

        {/* Save button — bottom right */}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            data-guide-id="accounts.create-submit"
            onClick={handleSubmit}
            disabled={saving || !canSubmit}
            className="h-8 rounded-lg bg-[var(--cafe-accent)] px-4 text-xs font-bold text-[var(--cafe-surface)] transition hover:bg-[var(--cafe-accent-hover)] disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
