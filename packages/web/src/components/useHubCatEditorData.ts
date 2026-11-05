'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { ConfigData } from './config-viewer-types';
import type { AccountsResponse, BuiltinAccountClient, ProfileItem } from './hub-accounts.types';
import {
  builtinAccountIdForClient,
  type CodexRuntimeSettings,
  DEFAULT_ANTIGRAVITY_COMMAND_ARGS,
  filterAccounts,
  type HubCatEditorFormState,
  initialState,
  type StrategyFormState,
  toCodexRuntimeSettings,
  toStrategyForm,
} from './hub-cat-editor.model';
import type { HubCatEditorProps } from './hub-cat-editor.types';
import type { CatStrategyEntry } from './hub-strategy-types';
import { useHubCatTemplates } from './useHubCatTemplates';

export function useHubCatEditorData({ cat, draft, existingCats, open, presentation }: HubCatEditorProps) {
  // The legacy account editor keeps its explicit binding contract. Native setup
  // is hosted by MemberSettingsPage; never reinterpret an existing member/draft.
  const initialForm = () => ({
    ...initialState(cat, draft),
    ...(!cat && !draft && presentation === 'page' ? { configurationSource: 'managed_account' as const } : {}),
  });
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [loadingStrategy, setLoadingStrategy] = useState(false);
  const [loadingCodexSettings, setLoadingCodexSettings] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  const [codexSettingsError, setCodexSettingsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [restoringCloudIdentity, setRestoringCloudIdentity] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<HubCatEditorFormState>(initialForm);
  const [strategyForm, setStrategyForm] = useState<StrategyFormState | null>(null);
  const [strategyBaseline, setStrategyBaseline] = useState<StrategyFormState | null>(null);
  const [strategyBaselineHasOverride, setStrategyBaselineHasOverride] = useState(false);
  const [codexSettings, setCodexSettings] = useState<CodexRuntimeSettings | null>(null);
  const [codexSettingsBaseline, setCodexSettingsBaseline] = useState<CodexRuntimeSettings | null>(null);
  const templateState = useHubCatTemplates(open && !cat);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>('custom');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const pendingProfileIdRef = useRef<string | null>(null);

  const availableProfiles = useMemo(() => filterAccounts(form.clientId, profiles), [form.clientId, profiles]);
  const selectedProfile = useMemo(
    () => availableProfiles.find((profile) => profile.id === form.accountRef) ?? null,
    [availableProfiles, form.accountRef],
  );
  const originalProfile = useMemo(
    () => profiles.find((profile) => profile.id === cat?.accountRef) ?? null,
    [cat?.accountRef, profiles],
  );
  const modelOptions = useMemo(() => {
    if (form.clientId === 'antigravity') return [];
    return selectedProfile?.models ?? [];
  }, [form.clientId, selectedProfile]);
  const protectedCloudIdentity = cat?.identityProtection?.kind === 'builtin-cloud' ? cat.identityProtection : null;
  const showCodexSettings =
    form.clientId === 'openai' && !protectedCloudIdentity && form.configurationSource !== 'native_tool';
  const codexSettingsEditable = !showCodexSettings || codexSettingsBaseline !== null;

  // Alias uniqueness: collect all patterns from OTHER cats (lowercase for comparison)
  const reservedPatterns = useMemo(() => {
    if (!existingCats?.length) return new Set<string>();
    const editingId = cat?.id;
    const set = new Set<string>();
    for (const c of existingCats) {
      if (c.id === editingId) continue;
      for (const p of c.mentionPatterns) set.add(p.toLowerCase());
    }
    return set;
  }, [existingCats, cat?.id]);

  useEffect(() => {
    if (!open) return;
    setForm(initialForm());
    setFieldErrors({});
    setSaveError(null);
    setStrategyError(null);
    setCodexSettingsError(null);
    setStrategyBaselineHasOverride(false);
    setCodexSettingsBaseline(null);
    setSelectedTemplateId('custom');
    setHasUnsavedChanges(false);
    setRestoringCloudIdentity(false);
    setShowAuthModal(false);
    pendingProfileIdRef.current = null;
  }, [open, cat, draft]);

  // Re-fetch profiles when Provider Profiles page creates/saves/deletes an account.
  const [profilesVersion, setProfilesVersion] = useState(0);
  useEffect(() => {
    const handler = () => setProfilesVersion((v) => v + 1);
    window.addEventListener('accounts-changed', handler);
    return () => window.removeEventListener('accounts-changed', handler);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: profilesVersion triggers an account reload after creation.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingProfiles(true);
    setProfilesError(null);
    apiFetch('/api/accounts')
      .then(async (res) => {
        if (!res.ok) throw new Error(`账号配置加载失败 (${res.status})`);
        return (await res.json()) as AccountsResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setProfiles(body.providers);
        const pendingProfileId = pendingProfileIdRef.current;
        if (!pendingProfileId) return;
        const createdProfile = body.providers.find((profile) => profile.id === pendingProfileId);
        if (!createdProfile) return;
        pendingProfileIdRef.current = null;
        setHasUnsavedChanges(true);
        setForm((prev) => ({
          ...prev,
          accountRef: createdProfile.id,
          defaultModel: createdProfile.models?.[0] ?? '',
          provider: '',
        }));
      })
      .catch((err) => {
        if (!cancelled) setProfilesError(err instanceof Error ? err.message : '账号配置加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoadingProfiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, profilesVersion]);

  useEffect(() => {
    if (!open || !cat) {
      setStrategyForm(null);
      setStrategyBaseline(null);
      setStrategyBaselineHasOverride(false);
      setLoadingStrategy(false);
      return;
    }
    let cancelled = false;
    setStrategyForm(null);
    setStrategyBaseline(null);
    setLoadingStrategy(true);
    apiFetch('/api/config/session-strategy')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Session 策略加载失败 (${res.status})`);
        return (await res.json()) as { cats?: CatStrategyEntry[] };
      })
      .then((body) => {
        if (cancelled) return;
        const entry = body.cats?.find((item) => item.catId === cat.id) ?? null;
        const nextStrategyForm = entry ? toStrategyForm(entry) : null;
        setStrategyForm(nextStrategyForm);
        setStrategyBaseline(nextStrategyForm);
        setStrategyBaselineHasOverride(Boolean(entry?.hasOverride));
      })
      .catch((err) => {
        if (!cancelled) setStrategyError(err instanceof Error ? err.message : 'Session 策略加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoadingStrategy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cat]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the member refresh above resets this baseline, so the same refresh must reread it.
  useEffect(() => {
    if (!open || !showCodexSettings) {
      setCodexSettings(null);
      setCodexSettingsBaseline(null);
      setLoadingCodexSettings(false);
      return;
    }
    let cancelled = false;
    setLoadingCodexSettings(true);
    Promise.resolve()
      .then(() => apiFetch('/api/config'))
      .then(async (res) => {
        if (!res.ok) throw new Error(`Codex 运行参数加载失败 (${res.status})`);
        return (await res.json()) as { config?: ConfigData };
      })
      .then((body) => {
        if (cancelled) return;
        const next = toCodexRuntimeSettings(body.config);
        setCodexSettings(next);
        setCodexSettingsBaseline(next);
      })
      .catch((err) => {
        if (!cancelled) {
          const fallback = toCodexRuntimeSettings();
          setCodexSettings((prev) => prev ?? fallback);
          setCodexSettingsError(err instanceof Error ? err.message : 'Codex 运行参数加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCodexSettings(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, showCodexSettings, cat]);

  useEffect(() => {
    if (form.clientId === 'antigravity') {
      setForm((prev) => (prev.accountRef === '' ? prev : { ...prev, accountRef: '' }));
      return;
    }
    setForm((prev) => {
      if (prev.accountRef.trim().length === 0 && (cat || !draft)) {
        return prev;
      }
      if (availableProfiles.length === 0) return prev;
      const preferredBuiltin = builtinAccountIdForClient(prev.clientId);
      const nextProfile =
        availableProfiles.find((profile) => profile.id === prev.accountRef) ??
        (preferredBuiltin ? availableProfiles.find((profile) => profile.id === preferredBuiltin) : null) ??
        availableProfiles[0] ??
        null;
      if (!nextProfile) return prev;
      if (prev.accountRef === nextProfile.id) return prev;
      return { ...prev, accountRef: nextProfile.id };
    });
  }, [availableProfiles, cat, draft, form.clientId]);

  // Auto-fill first available model only on profile/client change — NOT when
  // the user clears the field. Previous code had form.defaultModel in deps,
  // which re-filled immediately after the user cleared the input (#802).
  useEffect(() => {
    if (form.clientId === 'antigravity' || modelOptions.length === 0) return;
    setForm((prev) => {
      if (prev.clientId === 'antigravity' || prev.defaultModel.trim().length > 0) return prev;
      return { ...prev, defaultModel: modelOptions[0] ?? '' };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
    // excludes form.defaultModel: auto-fill runs on profile change, not on
    // user clearing the model input.
  }, [form.clientId, modelOptions]);

  useEffect(() => {
    if (form.clientId !== 'antigravity') return;
    if (form.commandArgs.trim().length > 0) return;
    setForm((prev) => {
      if (prev.clientId !== 'antigravity') return prev;
      if (prev.commandArgs.trim().length > 0) return prev;
      return { ...prev, commandArgs: DEFAULT_ANTIGRAVITY_COMMAND_ARGS };
    });
  }, [form.clientId, form.commandArgs]);

  const createAccountClient: BuiltinAccountClient | undefined =
    form.clientId === 'antigravity' ? undefined : form.clientId === 'catagent' ? 'anthropic' : form.clientId;
  const hasEmptyCreatableAccounts =
    !cat &&
    form.configurationSource !== 'native_tool' &&
    !loadingProfiles &&
    createAccountClient !== undefined &&
    availableProfiles.length === 0;
  const saveBlockedByProfileBinding = hasEmptyCreatableAccounts;

  return {
    profiles,
    loadingProfiles,
    loadingStrategy,
    loadingCodexSettings,
    uploadingAvatar,
    saveError,
    profilesError,
    strategyError,
    codexSettingsError,
    saving,
    restoringCloudIdentity,
    hasUnsavedChanges,
    fieldErrors,
    form,
    strategyForm,
    strategyBaseline,
    strategyBaselineHasOverride,
    codexSettings,
    codexSettingsBaseline,
    ...templateState,
    selectedTemplateId,
    showAuthModal,
    pendingProfileIdRef,
    availableProfiles,
    selectedProfile,
    originalProfile,
    modelOptions,
    protectedCloudIdentity,
    showCodexSettings,
    codexSettingsEditable,
    reservedPatterns,
    profilesVersion,
    createAccountClient,
    hasEmptyCreatableAccounts,
    saveBlockedByProfileBinding,
    setForm,
    setFieldErrors,
    setSaveError,
    setStrategyError,
    setCodexSettingsError,
    setStrategyBaseline,
    setStrategyBaselineHasOverride,
    setCodexSettingsBaseline,
    setSelectedTemplateId,
    setHasUnsavedChanges,
    setRestoringCloudIdentity,
    setShowAuthModal,
    setUploadingAvatar,
    setStrategyForm,
    setCodexSettings,
    setSaving,
    setProfilesVersion,
  };
}
