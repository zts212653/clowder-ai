'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { ConfigData } from './config-viewer-types';
import type { TemplateCard } from './first-run-quest/TemplateStep';
import type { AccountsResponse, ProfileItem } from './hub-accounts.types';
import { uploadAvatarAsset, uploadRefAudioAsset } from './hub-cat-editor.client';
import {
  autoSlug,
  buildCatPayload,
  buildCodexConfigPatches,
  buildStrategyPayload,
  builtinAccountIdForClient,
  type CodexRuntimeSettings,
  DEFAULT_ANTIGRAVITY_COMMAND_ARGS,
  filterAccounts,
  type HubCatEditorDraft,
  type HubCatEditorFormState,
  initialState,
  joinTags,
  normalizeMentionPattern,
  type StrategyFormState,
  splitMentionPatterns,
  toCodexRuntimeSettings,
  toStrategyForm,
  withDefaultModelMentionPattern,
} from './hub-cat-editor.model';
import { AccountSection, IdentitySection, RoutingSection } from './hub-cat-editor.sections';
import { AdvancedRuntimeSection } from './hub-cat-editor-advanced';
import { PersistenceBanner } from './hub-cat-editor-fields';
import type { CatStrategyEntry } from './hub-strategy-types';
import { useConfirm } from './useConfirm';

interface HubCatEditorProps {
  cat?: CatData | null;
  draft?: HubCatEditorDraft | null;
  /** All cats — used for alias uniqueness validation. */
  existingCats?: CatData[];
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  variant?: 'overlay' | 'inline';
  hideDelete?: boolean;
}

export function HubCatEditor({
  cat,
  draft,
  existingCats,
  open,
  onClose,
  onSaved,
  variant = 'overlay',
  hideDelete = false,
}: HubCatEditorProps) {
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [loadingStrategy, setLoadingStrategy] = useState(false);
  const [loadingCodexSettings, setLoadingCodexSettings] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  const [codexSettingsError, setCodexSettingsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<HubCatEditorFormState>(() => initialState(cat, draft));
  const [strategyForm, setStrategyForm] = useState<StrategyFormState | null>(null);
  const [strategyBaseline, setStrategyBaseline] = useState<StrategyFormState | null>(null);
  const [strategyBaselineHasOverride, setStrategyBaselineHasOverride] = useState(false);
  const [codexSettings, setCodexSettings] = useState<CodexRuntimeSettings | null>(null);
  const [codexSettingsBaseline, setCodexSettingsBaseline] = useState<CodexRuntimeSettings | null>(null);
  const [templates, setTemplates] = useState<TemplateCard[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>('custom');

  const availableProfiles = useMemo(() => filterAccounts(form.clientId, profiles), [form.clientId, profiles]);
  const selectedProfile = useMemo(
    () => availableProfiles.find((profile) => profile.id === form.accountRef) ?? null,
    [availableProfiles, form.accountRef],
  );
  const modelOptions = useMemo(() => {
    if (form.clientId === 'antigravity') return [];
    return selectedProfile?.models ?? [];
  }, [form.clientId, selectedProfile]);
  const showCodexSettings = form.clientId === 'openai';
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
    setForm(initialState(cat, draft));
    setFieldErrors({});
    setError(null);
    setStrategyError(null);
    setCodexSettingsError(null);
    setStrategyBaselineHasOverride(false);
    setCodexSettingsBaseline(null);
    setSelectedTemplateId('custom');
    setHasUnsavedChanges(false);
  }, [open, cat, draft]);

  // Re-fetch profiles when Provider Profiles page creates/saves/deletes an account.
  const [profilesVersion, setProfilesVersion] = useState(0);
  useEffect(() => {
    const handler = () => setProfilesVersion((v) => v + 1);
    window.addEventListener('accounts-changed', handler);
    return () => window.removeEventListener('accounts-changed', handler);
  }, []);

  useEffect(() => {
    if (!open || cat) {
      setTemplates([]);
      return;
    }
    let cancelled = false;
    apiFetch('/api/cat-templates')
      .then(async (res) => {
        if (!res.ok) throw new Error('load failed');
        return (await res.json()) as { templates?: TemplateCard[] };
      })
      .then((body) => {
        if (!cancelled) setTemplates(body.templates ?? []);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cat]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingProfiles(true);
    apiFetch('/api/accounts')
      .then(async (res) => {
        if (!res.ok) throw new Error(`账号配置加载失败 (${res.status})`);
        return (await res.json()) as AccountsResponse;
      })
      .then((body) => {
        if (!cancelled) setProfiles(body.providers);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '账号配置加载失败');
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
  }, [cat, open, showCodexSettings]);

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

  useEffect(() => {
    if (form.clientId === 'antigravity' || modelOptions.length === 0) return;
    if (form.defaultModel.trim().length > 0) return;
    setForm((prev) => {
      if (prev.clientId === 'antigravity' || prev.defaultModel.trim().length > 0) return prev;
      return { ...prev, defaultModel: modelOptions[0] ?? '' };
    });
  }, [form.clientId, form.defaultModel, modelOptions]);

  useEffect(() => {
    if (form.clientId !== 'antigravity') return;
    if (form.commandArgs.trim().length > 0) return;
    setForm((prev) => {
      if (prev.clientId !== 'antigravity') return prev;
      if (prev.commandArgs.trim().length > 0) return prev;
      return { ...prev, commandArgs: DEFAULT_ANTIGRAVITY_COMMAND_ARGS };
    });
  }, [form.clientId, form.commandArgs]);

  if (!open) return null;

  const saveBlockedByProfileBinding = false;

  const patchForm = (patch: Partial<HubCatEditorFormState>) => {
    setHasUnsavedChanges(true);
    setForm((prev) => ({ ...prev, ...patch }));
    if (patch.mentionPatterns !== undefined) {
      setFieldErrors((prev) => ({ ...prev, routing: false }));
    }
    if (patch.name !== undefined || patch.roleDescription !== undefined) {
      setFieldErrors((prev) => ({ ...prev, identity: false }));
    }
    if (patch.defaultModel !== undefined || patch.clientId !== undefined) {
      setFieldErrors((prev) => ({ ...prev, account: false }));
    }
  };
  const patchStrategy = (patch: Partial<StrategyFormState>) => {
    setHasUnsavedChanges(true);
    setStrategyForm((prev) => (prev ? { ...prev, ...patch } : prev));
  };
  const patchCodex = (patch: Partial<CodexRuntimeSettings>) => {
    setHasUnsavedChanges(true);
    setCodexSettings((prev) => ({
      ...(prev ?? toCodexRuntimeSettings()),
      ...patch,
    }));
  };

  const handleTemplateSelect = (t: TemplateCard | null) => {
    if (!t) {
      setSelectedTemplateId('custom');
      setForm(initialState(null, null));
      setHasUnsavedChanges(false);
      return;
    }
    setSelectedTemplateId(t.id);
    const name = t.name;
    const catId = autoSlug(name);
    // Auto-suffix aliases that conflict with existing cats
    const rawAliases = [t.nickname, name].filter((s): s is string => Boolean(s));
    const deduped = rawAliases.map((alias) => {
      const normalized = normalizeMentionPattern(alias);
      if (!reservedPatterns.has(normalized.toLowerCase())) return normalized;
      for (let i = 2; i <= 99; i++) {
        const candidate = normalizeMentionPattern(`${alias}${i}`);
        if (!reservedPatterns.has(candidate.toLowerCase())) return candidate;
      }
      return normalized; // fallback — backend will catch it
    });
    patchForm({
      name,
      displayName: name,
      nickname: t.nickname ?? '',
      avatar: t.avatar ?? '',
      colorPrimary: t.color.primary,
      colorSecondary: t.color.secondary,
      roleDescription: t.roleDescription,
      personality: t.personality,
      teamStrengths: t.teamStrengths ?? '',
      catId,
      mentionPatterns: joinTags(deduped),
    });
  };

  const requestClose = async () => {
    if (!hasUnsavedChanges) {
      onClose();
      return;
    }
    if (await confirm({ title: '关闭确认', message: '有未保存的修改，确定要关闭吗？' })) onClose();
  };

  const handleAvatarUpload = async (file: File) => {
    setUploadingAvatar(true);
    setError(null);
    try {
      patchForm({ avatar: await uploadAvatarAsset(file) });
    } catch (err) {
      setError(err instanceof Error ? err.message : '头像上传失败');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleRefAudioUpload = async (file: File) => {
    setError(null);
    try {
      const result = await uploadRefAudioAsset(file);
      patchForm({ voiceRefAudio: result.url });
    } catch (err) {
      setError(err instanceof Error ? err.message : '参考音频上传失败');
    }
  };

  const handleSave = async () => {
    const errors: Record<string, boolean> = {};
    const errorMessages: string[] = [];
    // Create-only pre-flight: existing cats already passed backend validation.
    if (!cat) {
      if (!form.name.trim()) {
        errors.identity = true;
        errorMessages.push('名称');
      }
      if (!form.roleDescription.trim()) {
        errors.identity = true;
        errorMessages.push('角色描述');
      }
      if (!form.defaultModel.trim() && selectedProfile?.authType === 'api_key') {
        errors.account = true;
        errorMessages.push('Model');
      } else if (
        form.clientId === 'opencode' &&
        selectedProfile?.authType === 'api_key' &&
        !form.provider.trim() &&
        (() => {
          const m = form.defaultModel.trim();
          const si = m.indexOf('/');
          const looksLike = si > 0 && si < m.length - 1;
          if (!looksLike) return true; // bare model, need provider
          // Known provider prefix → canonical (synced with BUILTIN_OPENCODE_PROVIDERS)
          const known = new Set(['anthropic', 'openai', 'openrouter', 'google']);
          if (known.has(m.slice(0, si))) return false;
          // Non-builtin: "x/y" in account list + bare "y" absent → namespace
          const acm = selectedProfile?.models ?? [];
          const bare = m.slice(si + 1);
          return acm.includes(m) && !acm.includes(bare);
        })()
      ) {
        errors.account = true;
        errorMessages.push('请使用 provider/model 格式（如 minimax/MiniMax-M2.7），或填写 Provider 名称');
      }
      const effectiveCreateForm = selectedProfile?.authType === 'api_key' ? withDefaultModelMentionPattern(form) : form;
      if (splitMentionPatterns(effectiveCreateForm.mentionPatterns).length === 0) {
        errors.routing = true;
        errorMessages.push('别名');
      }
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError(`请填写必填字段：${errorMessages.join('、')}`);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    setError(null);
    const rollbackSteps: Array<() => Promise<void>> = [];
    const rollbackMutations = async () => {
      for (const rollback of rollbackSteps.reverse()) {
        await rollback().catch(() => {});
      }
    };
    try {
      const effectiveForm =
        !cat && selectedProfile?.authType === 'api_key' ? withDefaultModelMentionPattern(form) : form;
      const catPayload = buildCatPayload(effectiveForm, cat);
      const rollbackCatPayload = cat ? buildCatPayload(initialState(cat, null), cat) : null;
      const strategyEditable = Boolean(
        cat && form.sessionChain === 'true' && (strategyForm?.sessionChainEnabled ?? true),
      );
      const nextStrategyPayload = strategyEditable && strategyForm ? buildStrategyPayload(strategyForm) : null;
      const baselineStrategyPayload =
        strategyEditable && strategyBaseline ? buildStrategyPayload(strategyBaseline) : null;
      const strategyChanged =
        cat && nextStrategyPayload && strategyEditable
          ? JSON.stringify(nextStrategyPayload) !== JSON.stringify(baselineStrategyPayload)
          : false;

      if (cat && strategyChanged && nextStrategyPayload) {
        const strategyRes = await apiFetch(`/api/config/session-strategy/${cat.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nextStrategyPayload),
        });
        if (!strategyRes.ok) {
          const payload = (await strategyRes.json().catch(() => ({}))) as Record<string, unknown>;
          setError((payload.error as string) ?? `Session 策略保存失败 (${strategyRes.status})`);
          return;
        }
        if (strategyBaselineHasOverride && baselineStrategyPayload) {
          rollbackSteps.push(async () => {
            await apiFetch(`/api/config/session-strategy/${cat.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(baselineStrategyPayload),
            });
          });
        } else {
          rollbackSteps.push(async () => {
            await apiFetch(`/api/config/session-strategy/${cat.id}`, {
              method: 'DELETE',
            });
          });
        }
      }

      const res = await apiFetch(cat ? `/api/cats/${cat.id}` : '/api/cats', {
        method: cat ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(catPayload),
      });
      if (!res.ok) {
        await rollbackMutations();
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((payload.error as string) ?? `保存失败 (${res.status})`);
        return;
      }
      const persistedCatBody = (await res.json().catch(() => ({}))) as { cat?: { id?: string } };
      const persistedCatId = persistedCatBody.cat?.id ?? cat?.id ?? null;
      if (persistedCatId) {
        if (cat && rollbackCatPayload) {
          rollbackSteps.push(async () => {
            await apiFetch(`/api/cats/${persistedCatId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(rollbackCatPayload),
            });
          });
        } else if (!cat) {
          rollbackSteps.push(async () => {
            await apiFetch(`/api/cats/${persistedCatId}`, {
              method: 'DELETE',
            });
          });
        }
      }

      if (showCodexSettings && codexSettings && codexSettingsBaseline) {
        const codexPatches = buildCodexConfigPatches(codexSettings, codexSettingsBaseline);
        const rollbackCodexPatches = buildCodexConfigPatches(codexSettingsBaseline, codexSettings);
        const appliedConfigPatchKeys: string[] = [];
        for (const patch of codexPatches) {
          const configRes = await apiFetch('/api/config', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          });
          if (!configRes.ok) {
            const appliedRollbackPatches = rollbackCodexPatches.filter((rollbackPatch) =>
              appliedConfigPatchKeys.includes(rollbackPatch.key),
            );
            for (const rollbackPatch of appliedRollbackPatches.reverse()) {
              await apiFetch('/api/config', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(rollbackPatch),
              }).catch(() => {});
            }
            await rollbackMutations();
            const payload = (await configRes.json().catch(() => ({}))) as Record<string, unknown>;
            setError((payload.error as string) ?? `Codex 运行参数保存失败 (${configRes.status})`);
            return;
          }
          appliedConfigPatchKeys.push(patch.key);
        }
      }

      await onSaved();
      window.dispatchEvent(new CustomEvent('guide:confirm', { detail: { target: 'member-editor.profile' } }));
      onClose();
    } catch (err) {
      await rollbackMutations();
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!cat || saving) return;
    const ok = await confirm({
      title: '删除确认',
      message: `确认删除成员「${cat.displayName || cat.name || cat.id}」吗？该操作不可撤销。`,
      variant: 'danger',
      confirmLabel: '删除',
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/cats/${cat.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((payload.error as string) ?? `删除失败 (${res.status})`);
        return;
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setSaving(false);
    }
  };

  const overlayTitle = cat ? cat.displayName || cat.name || cat.id : '添加成员';

  const editorHeader = (
    <div className="flex shrink-0 items-start justify-between px-7 py-5">
      <div className="flex items-center gap-2">
        {variant === 'inline' && (
          <button
            type="button"
            onClick={requestClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--console-hover-bg)] text-cafe-muted transition hover:text-cafe"
            aria-label="返回列表"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <p
          id={variant === 'overlay' ? 'member-editor-title' : undefined}
          className="text-[13px] font-extrabold text-[var(--console-modal-title)]"
        >
          {variant === 'overlay' ? overlayTitle : cat ? cat.displayName || cat.name || cat.id : '添加成员'}
        </p>
      </div>
      {variant === 'overlay' && (
        <button
          type="button"
          onClick={requestClose}
          className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--console-modal-close-bg)] text-lg font-extrabold leading-none text-[var(--console-modal-close-fg)] transition hover:opacity-80"
          aria-label="关闭成员配置"
        >
          ×
        </button>
      )}
    </div>
  );

  const editorBody = (
    <div className={`min-h-0 flex-1 space-y-4 overflow-y-auto px-7 py-5 ${variant === 'inline' ? 'pb-8' : ''}`}>
      {!cat && templates.length > 0 && (
        <section
          data-guide-id="add-member.template-picker"
          className="space-y-3 rounded-[18px] bg-[var(--console-card-bg)] p-[18px] shadow-[0_8px_22px_rgba(43,33,26,0.04)]"
        >
          <h4 className="text-base font-extrabold text-cafe">成员模板</h4>
          <p className="text-xs font-semibold text-cafe-secondary">
            从内置成员模板开始，选择后自动填充身份、模型与运行时默认值。
          </p>
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => handleTemplateSelect(null)}
              className={`h-8 rounded-2xl px-3.5 text-[13px] font-extrabold transition ${
                selectedTemplateId === 'custom'
                  ? 'bg-[var(--cafe-accent)] text-[var(--cafe-surface)]'
                  : 'bg-[var(--console-field-bg)] text-[var(--console-template-text)]'
              }`}
            >
              自定义
            </button>
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => handleTemplateSelect(selectedTemplateId === t.id ? null : t)}
                className={`h-8 rounded-2xl px-3.5 text-[13px] font-extrabold transition ${
                  selectedTemplateId === t.id
                    ? 'bg-[var(--cafe-accent)] text-[var(--cafe-surface)]'
                    : 'bg-[var(--console-field-bg)] text-[var(--console-template-text)]'
                }`}
              >
                {t.nickname ?? t.name}
              </button>
            ))}
          </div>
        </section>
      )}
      <IdentitySection
        cat={cat}
        form={form}
        hasError={fieldErrors.identity}
        avatarUploading={uploadingAvatar}
        onChange={patchForm}
        onAvatarUpload={handleAvatarUpload}
        onRefAudioUpload={handleRefAudioUpload}
      />
      <AccountSection
        form={form}
        hasError={fieldErrors.account}
        modelOptions={modelOptions}
        availableProfiles={availableProfiles}
        loadingProfiles={loadingProfiles}
        onChange={patchForm}
      />
      <RoutingSection
        form={form}
        hasError={fieldErrors.routing}
        reservedPatterns={reservedPatterns}
        onChange={patchForm}
      />
      <AdvancedRuntimeSection
        cat={cat}
        form={form}
        strategyForm={strategyForm}
        loadingStrategy={loadingStrategy}
        strategyError={strategyError}
        codexSettings={codexSettings}
        loadingCodexSettings={loadingCodexSettings}
        codexSettingsError={codexSettingsError}
        codexSettingsEditable={codexSettingsEditable}
        showCodexSettings={showCodexSettings}
        onChange={patchForm}
        onStrategyChange={patchStrategy}
        onCodexChange={patchCodex}
      />
      <PersistenceBanner />
      {error ? <p className="rounded-2xl bg-conn-red-bg px-4 py-3 text-sm text-conn-red-text">{error}</p> : null}
      <div className="flex items-center justify-between pt-4">
        {cat && !hideDelete ? (
          <button
            type="button"
            onClick={handleDelete}
            aria-label="删除成员"
            className="text-[13px] font-bold text-cafe-muted transition hover:text-conn-red-text"
          >
            删除成员
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || saveBlockedByProfileBinding}
          className="h-8 rounded-[10px] bg-[var(--cafe-accent)] px-4 text-[13px] font-extrabold text-[var(--cafe-surface)] transition hover:bg-[var(--cafe-accent-hover)] disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );

  if (variant === 'inline') {
    return (
      <div className="flex h-full flex-col" data-guide-id="member-editor.profile" data-bootcamp-step="cat-editor">
        {editorHeader}
        {editorBody}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--console-overlay-medium)] px-4"
      onClick={requestClose}
      data-bootcamp-host="cat-editor-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-editor-title"
        className="member-editor-modal flex max-h-[88vh] w-full max-w-[720px] flex-col overflow-hidden rounded-[28px] bg-[var(--console-card-bg)] shadow-[0_22px_48px_rgba(43,33,26,0.13)]"
        data-guide-id="member-editor.profile"
        onClick={(event) => event.stopPropagation()}
        data-bootcamp-step="cat-editor"
      >
        {editorHeader}
        {editorBody}
      </div>
    </div>
  );
}
