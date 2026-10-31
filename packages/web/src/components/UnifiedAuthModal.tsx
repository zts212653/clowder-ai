'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { AccountConnectionFields, isValidAccountEnvKey } from './AccountConnectionFields';
import { accountFormCopy } from './accounts/account-form.shell-copy';
import { accountMessage } from './accounts/account-message';
import { startCreatedCodexAccountLogin } from './codex-accounts/account-request';
import type { BuiltinAccountClient, ProfileAuthType, ProfileItem } from './hub-accounts.types';
import { builtinClientLabel } from './hub-accounts.view';
import { formInputClass } from './mcp-form-helpers';
import { useShellCopy } from './shell/shell-copy';
import { useShellLanguage } from './shell/shell-language';

const CLIENT_OPTIONS: BuiltinAccountClient[] = ['anthropic', 'openai', 'google', 'kimi', 'opencode', 'acp'];

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
  onCreated: (profileId: string, loginError?: string, profile?: ProfileItem) => void;
  editProfile?: UnifiedAuthEditData;
  /** When provided, locks client to this value (wizard context). */
  initialClientId?: BuiltinAccountClient;
  initialAuthType?: ProfileAuthType;
}

export function UnifiedAuthModal({
  open,
  onClose,
  onCreated,
  editProfile,
  initialClientId,
  initialAuthType,
}: UnifiedAuthModalProps) {
  const t = useShellCopy(accountFormCopy);
  const language = useShellLanguage();
  const isEdit = Boolean(editProfile);
  const defaultClientId =
    editProfile?.clientId ?? initialClientId ?? (editProfile?.authType === 'api_key' ? undefined : 'openai');
  const [authMode, setAuthMode] = useState<AuthMode>(editProfile?.authType ?? initialAuthType ?? 'oauth');
  const [clientId, setClientId] = useState<BuiltinAccountClient | undefined>(defaultClientId);
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
      const cid =
        editProfile?.clientId ?? initialClientId ?? (editProfile?.authType === 'api_key' ? undefined : 'openai');
      setClientId(cid);
      setAuthMode(editProfile?.authType ?? initialAuthType ?? 'oauth');
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
  }, [open, editProfile, initialClientId, initialAuthType]);

  if (!open) return null;

  const isOAuth = authMode === 'oauth';
  const isCodexLogin = isOAuth && (initialClientId ?? clientId) === 'openai';

  /** Build envVars Record from entries, filtering empty/invalid/reserved keys. */
  const buildEnvVars = (): Record<string, string> | undefined => {
    const vars: Record<string, string> = {};
    for (const { key, value } of envEntries) {
      const k = key.trim();
      if (!k || !isValidAccountEnvKey(k)) continue;
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

  const canSubmit =
    Boolean(clientId) &&
    (isOAuth
      ? isCodexLogin || Boolean(displayName.trim())
      : Boolean(displayName.trim()) && models.length > 0 && (isEdit || Boolean(baseUrl.trim() && apiKey.trim())));

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
        patch.clientId = initialClientId ?? clientId;
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
            displayName: displayName.trim() || (isCodexLogin ? t.codexDefaultName : ''),
            authType: 'oauth',
            clientId: effectiveClientId,
            ...(!isCodexLogin && models.length > 0 ? { models } : {}),
            ...(() => {
              if (isCodexLogin) return {};
              const ev = buildEnvVars();
              return ev ? { envVars: ev } : {};
            })(),
          }),
        });
        const body = (await res.json()) as { profile?: ProfileItem; error?: string };
        if (!res.ok) throw new Error(body.error ?? `创建失败 (${res.status})`);
        if (body.profile?.id) {
          const login = isCodexLogin ? await startCreatedCodexAccountLogin(body.profile) : undefined;
          resetForm();
          if (isCodexLogin) onCreated(body.profile.id, login?.loginError, login?.profile);
          else onCreated(body.profile.id);
          onClose();
        }
      } else {
        const res = await apiFetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: displayName.trim(),
            authType: 'api_key',
            clientId: initialClientId ?? clientId,
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

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[var(--console-overlay-medium)] px-4 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-semibold text-cafe-primary">{isEdit ? t.edit : t.add}</h3>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full p-1 text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-secondary"
            aria-label={t.close}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Mode toggle */}
        <div
          className={`mb-4 flex rounded-lg border border-[var(--console-border-soft)] p-0.5 ${isEdit ? 'opacity-50' : ''}`}
        >
          <button
            type="button"
            onClick={() => {
              if (!isEdit) {
                setAuthMode('oauth');
                setClientId('openai');
              }
            }}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${
              isOAuth ? 'bg-cafe-accent text-[var(--cafe-surface)] shadow-sm' : 'text-cafe-secondary'
            } ${isEdit ? 'cursor-not-allowed' : !isOAuth ? 'hover:bg-[var(--console-hover-bg)]' : ''}`}
            disabled={isEdit}
          >
            {t.login}
          </button>
          <button
            type="button"
            onClick={() => !isEdit && setAuthMode('api_key')}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${
              !isOAuth ? 'bg-cafe-accent text-[var(--cafe-surface)] shadow-sm' : 'text-cafe-secondary'
            } ${isEdit ? 'cursor-not-allowed' : isOAuth ? 'hover:bg-[var(--console-hover-bg)]' : ''}`}
            disabled={isEdit}
          >
            API Key
          </button>
        </div>

        <div className="space-y-3" data-guide-id="accounts.create-details">
          {/* 账号名称 — always shown */}
          <div>
            <label className="mb-1 block text-xs font-medium text-cafe-secondary">
              {isCodexLogin && !isEdit ? t.noteOptional : t.name}
            </label>
            <input
              aria-label={isCodexLogin ? t.note : t.name}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={isCodexLogin ? t.noteHint : t.nameHint}
              className={formInputClass}
            />
          </div>

          {/* Authentication mode does not erase account identity. */}
          <div>
            <label className="mb-1 block text-xs font-medium text-cafe-secondary">
              {isOAuth ? t.provider : t.keyOwner}
            </label>
            {initialClientId ? (
              <p className={formInputClass}>{builtinClientLabel(initialClientId)}</p>
            ) : (
              <select
                aria-label={isOAuth ? t.provider : t.keyOwner}
                value={clientId ?? ''}
                onChange={(e) => setClientId(e.target.value as BuiltinAccountClient)}
                className={formInputClass}
              >
                {!clientId && (
                  <option value="" disabled>
                    {t.chooseProvider}
                  </option>
                )}
                {(isOAuth && !isEdit ? ['openai' as const] : CLIENT_OPTIONS).map((c) => (
                  <option key={c} value={c}>
                    {builtinClientLabel(c)}
                  </option>
                ))}
              </select>
            )}
          </div>

          {isCodexLogin && !isEdit && <p className="text-sm text-cafe-muted">{t.loginHint}</p>}

          {!isEdit && <p className="text-sm text-cafe-muted">{t.bindingsHint}</p>}
          <AccountConnectionFields
            isOAuth={isOAuth}
            isCodexLogin={isCodexLogin}
            isEdit={isEdit}
            clientId={clientId}
            initialClientId={initialClientId}
            baseUrl={baseUrl}
            setBaseUrl={setBaseUrl}
            apiKey={apiKey}
            setApiKey={setApiKey}
            models={models}
            setModels={setModels}
            envEntries={envEntries}
            setEnvEntries={setEnvEntries}
            advancedOpen={advancedOpen}
            setAdvancedOpen={setAdvancedOpen}
            clearError={() => setError(null)}
          />
        </div>

        {error && <p className="mt-3 text-xs text-semantic-critical">{accountMessage(error, language)}</p>}

        {/* Save button — bottom right */}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            data-guide-id="accounts.create-submit"
            onClick={handleSubmit}
            disabled={saving || !canSubmit}
            className="rounded-lg bg-cafe-accent px-5 py-2 text-sm font-semibold text-[var(--cafe-surface)] transition hover:bg-cafe-accent-hover disabled:opacity-50"
          >
            {saving ? t.processing : isCodexLogin && !isEdit ? t.createLogin : t.save}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
