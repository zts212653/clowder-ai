'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { ConfigData } from './config-viewer-types';
import { buildEditorLoadingNote, uploadAvatarAsset } from './hub-cat-editor.client';
import {
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
  type StrategyFormState,
  splitMentionPatterns,
  toCodexRuntimeSettings,
  toStrategyForm,
} from './hub-cat-editor.model';
import { AccountSection, IdentitySection, RoutingSection } from './hub-cat-editor.sections';
import { AdvancedRuntimeSection } from './hub-cat-editor-advanced';
import { PersistenceBanner } from './hub-cat-editor-fields';
import type { ProfileItem, ProviderProfilesResponse } from './hub-provider-profiles.types';
import type { CatStrategyEntry } from './hub-strategy-types';
import { useConfirm } from './useConfirm';

interface HubCatEditorProps {
  cat?: CatData | null;
  draft?: HubCatEditorDraft | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

export function HubCatEditor({ cat, draft, open, onClose, onSaved }: HubCatEditorProps) {
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

  const availableProfiles = useMemo(() => filterAccounts(form.client, profiles), [form.client, profiles]);
  const selectedProfile = useMemo(
    () => availableProfiles.find((profile) => profile.id === form.accountRef) ?? null,
    [availableProfiles, form.accountRef],
  );
  const modelOptions = useMemo(() => {
    if (form.client === 'antigravity') return [];
    return selectedProfile?.models ?? [];
  }, [form.client, selectedProfile]);
  const showCodexSettings = form.client === 'openai';
  const codexSettingsEditable = !showCodexSettings || codexSettingsBaseline !== null;

  useEffect(() => {
    if (!open) return;
    setForm(initialState(cat, draft));
    setFieldErrors({});
    setError(null);
    setStrategyError(null);
    setCodexSettingsError(null);
    setStrategyBaselineHasOverride(false);
    setCodexSettingsBaseline(null);
    setHasUnsavedChanges(false);
  }, [open, cat, draft]);

  // Re-fetch profiles when Provider Profiles page creates/saves/deletes an account.
  const [profilesVersion, setProfilesVersion] = useState(0);
  useEffect(() => {
    const handler = () => setProfilesVersion((v) => v + 1);
    window.addEventListener('provider-profiles-changed', handler);
    return () => window.removeEventListener('provider-profiles-changed', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingProfiles(true);
    apiFetch('/api/provider-profiles')
      .then(async (res) => {
        if (!res.ok) throw new Error(`账号配置加载失败 (${res.status})`);
        return (await res.json()) as ProviderProfilesResponse;
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
    if (form.client === 'antigravity') {
      setForm((prev) => (prev.accountRef === '' ? prev : { ...prev, accountRef: '' }));
      return;
    }
    setForm((prev) => {
      if (prev.accountRef.trim().length === 0 && (cat || !draft)) {
        return prev;
      }
      if (availableProfiles.length === 0) return prev;
      const preferredBuiltin = builtinAccountIdForClient(prev.client);
      const nextProfile =
        availableProfiles.find((profile) => profile.id === prev.accountRef) ??
        (preferredBuiltin ? availableProfiles.find((profile) => profile.id === preferredBuiltin) : null) ??
        availableProfiles[0] ??
        null;
      if (!nextProfile) return prev;
      if (prev.accountRef === nextProfile.id) return prev;
      return { ...prev, accountRef: nextProfile.id };
    });
  }, [availableProfiles, cat, draft, form.client]);

  useEffect(() => {
    if (form.client === 'antigravity' || modelOptions.length === 0) return;
    if (form.defaultModel.trim().length > 0) return;
    setForm((prev) => {
      if (prev.client === 'antigravity' || prev.defaultModel.trim().length > 0) return prev;
      return { ...prev, defaultModel: modelOptions[0] ?? '' };
    });
  }, [form.client, form.defaultModel, modelOptions]);

  useEffect(() => {
    if (form.client !== 'kimi') return;
    if (selectedProfile?.authType !== 'api_key') return;
    if (modelOptions.length === 0) return;
    const currentModel = form.defaultModel.trim();
    if (currentModel && modelOptions.includes(currentModel)) return;
    setForm((prev) => {
      if (prev.client !== 'kimi') return prev;
      if (prev.accountRef !== form.accountRef) return prev;
      const nextModel = modelOptions[0] ?? '';
      if (!nextModel || prev.defaultModel.trim() === nextModel) return prev;
      return { ...prev, defaultModel: nextModel };
    });
  }, [form.accountRef, form.client, form.defaultModel, modelOptions, selectedProfile?.authType]);

  useEffect(() => {
    if (form.client !== 'antigravity') return;
    if (form.commandArgs.trim().length > 0) return;
    setForm((prev) => {
      if (prev.client !== 'antigravity') return prev;
      if (prev.commandArgs.trim().length > 0) return prev;
      return { ...prev, commandArgs: DEFAULT_ANTIGRAVITY_COMMAND_ARGS };
    });
  }, [form.client, form.commandArgs]);

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
    if (patch.defaultModel !== undefined || patch.client !== undefined) {
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
      if (!form.defaultModel.trim()) {
        errors.account = true;
        errorMessages.push('Model');
      } else if (
        form.client === 'opencode' &&
        selectedProfile?.authType === 'api_key' &&
        !form.ocProviderName.trim() &&
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
      if (splitMentionPatterns(form.mentionPatterns).length === 0) {
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
      const catPayload = buildCatPayload(form, cat);
      const rollbackCatPayload = cat ? buildCatPayload(initialState(cat, null), cat) : null;
      const nextStrategyPayload = cat && strategyForm ? buildStrategyPayload(strategyForm) : null;
      const baselineStrategyPayload = cat && strategyBaseline ? buildStrategyPayload(strategyBaseline) : null;
      const strategyChanged =
        cat && nextStrategyPayload
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
      onClose();
    } catch (err) {
      await rollbackMutations();
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!cat) return;
    const ok = await confirm({
      title: '删除确认',
      message: `确认删除成员「${cat.displayName}」吗？此操作不可撤销。`,
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

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4" onClick={requestClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-[560px] flex-col rounded-[32px] border border-[#F0DDCD] bg-[#FFF8F2] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between border-b border-[#F0DDCD] px-7 py-5">
          <div>
            <p className="text-[13px] font-semibold text-[#77A777]">
              成员协作 &gt; 总览 &gt; {cat ? '编辑成员' : '添加成员'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {cat && cat.source === 'runtime' ? (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="rounded-full bg-red-50 p-2 text-red-600 transition hover:bg-red-100 disabled:opacity-50"
                aria-label="删除成员"
              >
                <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" aria-hidden="true">
                  <path
                    d="M3.5 4.5h9m-7.5 0V3.25h5V4.5m-5.5 0 .5 8h5l.5-8m-4 2v4m2-4v4"
                    strokeWidth="1.25"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}
            <button
              type="button"
              onClick={requestClose}
              className="text-2xl leading-none text-[#B59A88]"
              aria-label="关闭"
            >
              ×
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-7 py-5">
          <IdentitySection
            cat={cat}
            form={form}
            hasError={fieldErrors.identity}
            avatarUploading={uploadingAvatar}
            onChange={patchForm}
            onAvatarUpload={handleAvatarUpload}
          />
          <AccountSection
            form={form}
            hasError={fieldErrors.account}
            modelOptions={modelOptions}
            availableProfiles={availableProfiles}
            loadingProfiles={loadingProfiles}
            onChange={patchForm}
          />
          <RoutingSection form={form} hasError={fieldErrors.routing} onChange={patchForm} />
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
          {error ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p> : null}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-[#F0DDCD] bg-[#FFF3EA] px-7 py-4">
          <div className="text-xs leading-5 text-[#8A776B]">
            {buildEditorLoadingNote({ loadingProfiles, loadingStrategy, loadingCodexSettings })}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={requestClose}
              className="rounded-full bg-[#F7F3F0] px-5 py-2.5 text-sm font-semibold text-[#8A776B] transition hover:bg-[#F7EEE6]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || saveBlockedByProfileBinding}
              className="rounded-full bg-[#D49266] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#C88254] disabled:opacity-50"
            >
              {saving ? '保存中…' : cat ? '保存修改' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
