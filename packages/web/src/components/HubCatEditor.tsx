'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { ConfigData } from './config-viewer-types';
import { AdvancedRuntimeSection } from './hub-cat-editor-advanced';
import { buildEditorLoadingNote, uploadAvatarAsset } from './hub-cat-editor.client';
import { PersistenceBanner } from './hub-cat-editor-fields';
import {
  buildCatPayload,
  buildStrategyPayload,
  filterProfiles,
  initialState,
  toCodexRuntimeSettings,
  toStrategyForm,
  type HubCatEditorDraft,
  type CodexRuntimeSettings,
  type HubCatEditorFormState,
  type StrategyFormState,
} from './hub-cat-editor.model';
import type { ProfileItem, ProviderProfilesResponse } from './hub-provider-profiles.types';
import { AccountSection, IdentitySection, RoutingSection } from './hub-cat-editor.sections';
import type { CatStrategyEntry } from './hub-strategy-types';

interface HubCatEditorProps {
  cat?: CatData | null;
  draft?: HubCatEditorDraft | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

export function HubCatEditor({ cat, draft, open, onClose, onSaved }: HubCatEditorProps) {
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [loadingStrategy, setLoadingStrategy] = useState(false);
  const [loadingCodexSettings, setLoadingCodexSettings] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  const [codexSettingsError, setCodexSettingsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<HubCatEditorFormState>(() => initialState(cat, draft));
  const [strategyForm, setStrategyForm] = useState<StrategyFormState | null>(null);
  const [strategyBaseline, setStrategyBaseline] = useState<StrategyFormState | null>(null);
  const [codexSettings, setCodexSettings] = useState<CodexRuntimeSettings | null>(null);

  const availableProfiles = useMemo(() => filterProfiles(form.client, profiles), [form.client, profiles]);
  const selectedProfile = useMemo(() => availableProfiles.find((profile) => profile.id === form.providerProfileId) ?? null, [availableProfiles, form.providerProfileId]);
  const showCodexSettings = form.client === 'openai';
  const requiresApiKeyBinding = form.client === 'dare' || form.client === 'opencode';
  const saveBlockedByProfileBinding =
    requiresApiKeyBinding &&
    (loadingProfiles || form.providerProfileId.trim().length === 0 || selectedProfile?.authType !== 'api_key');

  useEffect(() => {
    if (!open) return;
    setForm(initialState(cat, draft));
    setError(null);
    setStrategyError(null);
    setCodexSettingsError(null);
  }, [open, cat, draft]);

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
  }, [open]);

  useEffect(() => {
    if (!open || !cat) {
      setStrategyForm(null);
      setStrategyBaseline(null);
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
      setLoadingCodexSettings(false);
      return;
    }
    if (!cat) {
      const defaults = toCodexRuntimeSettings();
      setCodexSettings(defaults);
      setLoadingCodexSettings(false);
      return;
    }
    let cancelled = false;
    setLoadingCodexSettings(true);
    apiFetch('/api/config')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Codex 运行参数加载失败 (${res.status})`);
        return (await res.json()) as { config?: ConfigData };
      })
      .then((body) => {
        if (cancelled) return;
        const next = toCodexRuntimeSettings(body.config);
        setCodexSettings(next);
      })
      .catch((err) => {
        if (!cancelled) setCodexSettingsError(err instanceof Error ? err.message : 'Codex 运行参数加载失败');
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
      setForm((prev) => (prev.providerProfileId === '' ? prev : { ...prev, providerProfileId: '' }));
      return;
    }
    const requiresApiKeyBinding = form.client === 'dare' || form.client === 'opencode';
    setForm((prev) => {
      if (availableProfiles.length === 0) return prev;
      if (prev.providerProfileId === '' && !requiresApiKeyBinding) return prev;
      const nextProfile =
        availableProfiles.find((profile) => profile.id === prev.providerProfileId) ?? availableProfiles[0] ?? null;
      if (!nextProfile) return prev;
      const sameProfile = prev.providerProfileId === nextProfile.id;
      const hasDefaultModel = prev.defaultModel.trim().length > 0;
      const modelSupported = hasDefaultModel && nextProfile.models.includes(prev.defaultModel);
      let nextModel = prev.defaultModel;
      if (!hasDefaultModel) {
        nextModel = nextProfile.models[0] ?? '';
      } else if (!modelSupported && !sameProfile) {
        nextModel = nextProfile.models[0] ?? prev.defaultModel;
      }
      if (prev.providerProfileId === nextProfile.id && prev.defaultModel === nextModel) return prev;
      return { ...prev, providerProfileId: nextProfile.id, defaultModel: nextModel };
    });
  }, [availableProfiles, form.client, form.providerProfileId, form.defaultModel]);

  if (!open) return null;

  const patchForm = (patch: Partial<HubCatEditorFormState>) => setForm((prev) => ({ ...prev, ...patch }));
  const patchStrategy = (patch: Partial<StrategyFormState>) =>
    setStrategyForm((prev) => (prev ? { ...prev, ...patch } : prev));
  const patchCodex = (patch: Partial<CodexRuntimeSettings>) =>
    setCodexSettings((prev) => ({
      ...(prev ?? toCodexRuntimeSettings()),
      ...patch,
    }));

  const handleAvatarUpload = async (file: File) => {
    setUploadingAvatar(true);
    setError(null);
    try {
      patchForm({ avatar: await uploadAvatarAsset(file) });
    } catch (err) { setError(err instanceof Error ? err.message : '头像上传失败'); } finally { setUploadingAvatar(false); }
  };

  const handleSave = async () => {
    if (saveBlockedByProfileBinding) {
      setError(loadingProfiles ? 'Provider 列表加载中，请稍后保存' : 'Dare/OpenCode 需要绑定 API Key Provider 后才能保存');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(cat ? `/api/cats/${cat.id}` : '/api/cats', {
        method: cat ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildCatPayload(form, cat)),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((payload.error as string) ?? `保存失败 (${res.status})`);
        return;
      }

      if (cat && strategyForm) {
        const nextStrategyPayload = buildStrategyPayload(strategyForm);
        const baselineStrategyPayload = strategyBaseline ? buildStrategyPayload(strategyBaseline) : null;
        if (JSON.stringify(nextStrategyPayload) !== JSON.stringify(baselineStrategyPayload)) {
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
        }
      }

      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!cat) return;
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-[32px] border border-[#F0DDCD] bg-[#FFF8F2] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-[#F0DDCD] px-7 py-5">
          <div>
            <p className="text-xs font-semibold text-[#77A777]">成员协作 &gt; 总览 &gt; {cat ? '编辑成员' : '添加成员'}</p>
            <h3 className="mt-2 text-2xl font-bold text-[#2D2118]">{cat ? '成员配置' : '添加成员'}</h3>
            <p className="mt-1 text-sm text-[#8A776B]">成员配置：身份、认证、路由、高级参数一站到位</p>
          </div>
          <div className="flex items-center gap-2">
            {cat && cat.source === 'runtime' ? (
              <button type="button" onClick={handleDelete} disabled={saving} className="rounded-full bg-red-50 p-2 text-red-600 transition hover:bg-red-100 disabled:opacity-50" aria-label="删除成员">
                <svg viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current" aria-hidden="true"><path d="M3.5 4.5h9m-7.5 0V3.25h5V4.5m-5.5 0 .5 8h5l.5-8m-4 2v4m2-4v4" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            ) : null}
            <button type="button" onClick={onClose} className="text-2xl leading-none text-[#B59A88]" aria-label="关闭">×</button>
          </div>
        </div>

        <div className="space-y-5 px-7 py-6">
          <IdentitySection
            cat={cat}
            form={form}
            avatarUploading={uploadingAvatar}
            onChange={patchForm}
            onAvatarUpload={handleAvatarUpload}
          />
          <AccountSection
            form={form}
            availableProfiles={availableProfiles}
            selectedProfile={selectedProfile}
            loadingProfiles={loadingProfiles}
            onChange={patchForm}
          />
          <RoutingSection form={form} onChange={patchForm} />
          <AdvancedRuntimeSection
            cat={cat}
            form={form}
            strategyForm={strategyForm}
            loadingStrategy={loadingStrategy}
            strategyError={strategyError}
            codexSettings={codexSettings}
            loadingCodexSettings={loadingCodexSettings}
            codexSettingsError={codexSettingsError}
            showCodexSettings={showCodexSettings}
            onChange={patchForm}
            onStrategyChange={patchStrategy}
            onCodexChange={patchCodex}
          />
          <PersistenceBanner />
          {error ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p> : null}
        </div>

        <div className="flex items-center justify-between border-t border-[#F0DDCD] bg-[#FFF3EA] px-7 py-4">
          <div className="text-xs text-[#8A776B]">{buildEditorLoadingNote({ loadingProfiles, loadingStrategy, loadingCodexSettings })}</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl bg-white px-4 py-2 text-sm text-[#6A5A50] transition hover:bg-[#F7EEE6]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || saveBlockedByProfileBinding}
              className="rounded-xl bg-[#D49266] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#C88254] disabled:opacity-50"
            >
              {saving ? '保存中…' : cat ? '保存修改' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
