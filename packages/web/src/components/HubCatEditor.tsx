'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { ProfileItem, ProviderProfilesResponse } from './hub-provider-profiles.types';
import type { CatStrategyEntry, StrategyType } from './hub-strategy-types';

type ClientValue = 'anthropic' | 'openai' | 'google' | 'dare' | 'opencode' | 'antigravity';

interface HubCatEditorProps {
  cat?: CatData | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

const CLIENT_OPTIONS: Array<{ value: ClientValue; label: string }> = [
  { value: 'anthropic', label: 'Claude' },
  { value: 'openai', label: 'Codex' },
  { value: 'google', label: 'Gemini' },
  { value: 'dare', label: 'Dare' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'antigravity', label: 'Antigravity' },
];

function splitMentionPatterns(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function splitCommandArgs(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function protocolForClient(client: ClientValue): 'anthropic' | 'openai' | 'google' | null {
  switch (client) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'google':
      return 'google';
    default:
      return null;
  }
}

function filterProfiles(client: ClientValue, profiles: ProfileItem[]): ProfileItem[] {
  if (client === 'antigravity') return [];
  if (client === 'dare' || client === 'opencode') {
    return profiles.filter((profile) => profile.authType === 'api_key');
  }
  const protocol = protocolForClient(client);
  return profiles.filter((profile) => profile.authType === 'api_key' || profile.protocol === protocol);
}

function initialState(cat?: CatData | null) {
  return {
    catId: cat?.id ?? '',
    name: cat?.name ?? cat?.displayName ?? '',
    displayName: cat?.displayName ?? '',
    avatar: cat?.avatar ?? '',
    colorPrimary: cat?.color.primary ?? '#9B7EBD',
    colorSecondary: cat?.color.secondary ?? '#E8DFF5',
    mentionPatterns: cat?.mentionPatterns.join(', ') ?? '',
    roleDescription: cat?.roleDescription ?? '',
    personality: cat?.personality ?? '',
    client: (cat?.provider as ClientValue | undefined) ?? 'anthropic',
    providerProfileId: cat?.providerProfileId ?? '',
    defaultModel: cat?.defaultModel ?? '',
    commandArgs: cat?.commandArgs?.join(' ') ?? '',
    maxPromptTokens: cat?.contextBudget ? String(cat.contextBudget.maxPromptTokens) : '',
    maxContextTokens: cat?.contextBudget ? String(cat.contextBudget.maxContextTokens) : '',
    maxMessages: cat?.contextBudget ? String(cat.contextBudget.maxMessages) : '',
    maxContentLengthPerMsg: cat?.contextBudget ? String(cat.contextBudget.maxContentLengthPerMsg) : '',
  };
}

function buildContextBudget(form: ReturnType<typeof initialState>) {
  const values = [
    form.maxPromptTokens,
    form.maxContextTokens,
    form.maxMessages,
    form.maxContentLengthPerMsg,
  ].map((value) => value.trim());
  const filledCount = values.filter((value) => value.length > 0).length;
  if (filledCount === 0) return undefined;
  if (filledCount !== values.length) {
    throw new Error('上下文预算要么全部留空，要么 4 项都填写');
  }

  const parsed = values.map((value) => Number.parseInt(value, 10));
  if (parsed.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('上下文预算必须是正整数');
  }

  return {
    maxPromptTokens: parsed[0]!,
    maxContextTokens: parsed[1]!,
    maxMessages: parsed[2]!,
    maxContentLengthPerMsg: parsed[3]!,
  };
}

interface StrategyFormState {
  strategy: StrategyType;
  warnThreshold: string;
  actionThreshold: string;
  maxCompressions: string;
  hybridCapable: boolean;
  sessionChainEnabled: boolean;
}

function toStrategyForm(entry: CatStrategyEntry): StrategyFormState {
  return {
    strategy: entry.effective.strategy,
    warnThreshold: String(entry.effective.thresholds.warn),
    actionThreshold: String(entry.effective.thresholds.action),
    maxCompressions: String(entry.effective.hybrid?.maxCompressions ?? 2),
    hybridCapable: entry.hybridCapable,
    sessionChainEnabled: entry.sessionChainEnabled,
  };
}

function buildStrategyPayload(strategy: StrategyFormState) {
  const warn = Number.parseFloat(strategy.warnThreshold);
  const action = Number.parseFloat(strategy.actionThreshold);
  if (!Number.isFinite(warn) || !Number.isFinite(action)) {
    throw new Error('Session 阈值必须是数字');
  }
  if (warn >= action) {
    throw new Error('Warn Threshold 必须小于 Action Threshold');
  }

  const payload: Record<string, unknown> = {
    strategy: strategy.strategy,
    thresholds: { warn, action },
  };
  if (strategy.strategy === 'hybrid') {
    const maxCompressions = Number.parseInt(strategy.maxCompressions, 10);
    if (!Number.isFinite(maxCompressions) || maxCompressions <= 0) {
      throw new Error('Max Compressions 必须是正整数');
    }
    payload.hybrid = { maxCompressions };
  }
  return payload;
}

export function HubCatEditor({ cat, open, onClose, onSaved }: HubCatEditorProps) {
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [loadingStrategy, setLoadingStrategy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => initialState(cat));
  const [strategyForm, setStrategyForm] = useState<StrategyFormState | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(initialState(cat));
    setStrategyError(null);
  }, [open, cat]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingProfiles(true);
    setError(null);
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
      setLoadingStrategy(false);
      return;
    }
    let cancelled = false;
    setLoadingStrategy(true);
    setStrategyError(null);
    apiFetch('/api/config/session-strategy')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Session 策略加载失败 (${res.status})`);
        return (await res.json()) as { cats?: CatStrategyEntry[] };
      })
      .then((body) => {
        if (cancelled) return;
        const entry = body.cats?.find((item) => item.catId === cat.id) ?? null;
        setStrategyForm(entry ? toStrategyForm(entry) : null);
      })
      .catch((err) => {
        if (!cancelled) {
          setStrategyError(err instanceof Error ? err.message : 'Session 策略加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingStrategy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cat]);

  const availableProfiles = useMemo(() => filterProfiles(form.client, profiles), [form.client, profiles]);
  const selectedProfile = useMemo(
    () => availableProfiles.find((profile) => profile.id === form.providerProfileId) ?? null,
    [availableProfiles, form.providerProfileId],
  );

  useEffect(() => {
    if (form.client === 'antigravity') {
      if (form.providerProfileId !== '') {
        setForm((prev) => ({ ...prev, providerProfileId: '' }));
      }
      return;
    }
    if (availableProfiles.length === 0) return;
    const hasSelected = availableProfiles.some((profile) => profile.id === form.providerProfileId);
    if (!hasSelected) {
      const nextProfile = availableProfiles[0];
      setForm((prev) => ({
        ...prev,
        providerProfileId: nextProfile?.id ?? '',
        defaultModel: prev.defaultModel || nextProfile?.models[0] || prev.defaultModel,
      }));
    }
  }, [availableProfiles, form.client, form.providerProfileId]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const contextBudget = buildContextBudget(form);
      const common = {
        name: form.name.trim(),
        displayName: form.displayName.trim(),
        avatar: form.avatar.trim(),
        color: {
          primary: form.colorPrimary.trim(),
          secondary: form.colorSecondary.trim(),
        },
        mentionPatterns: splitMentionPatterns(form.mentionPatterns),
        roleDescription: form.roleDescription.trim(),
        personality: form.personality.trim(),
        ...(contextBudget ? { contextBudget } : {}),
      };
      const body =
        form.client === 'antigravity'
          ? {
              ...common,
              ...(cat ? {} : { catId: form.catId.trim() }),
              client: 'antigravity',
              defaultModel: form.defaultModel.trim(),
              commandArgs: splitCommandArgs(form.commandArgs),
            }
          : {
              ...common,
              ...(cat ? {} : { catId: form.catId.trim() }),
              client: form.client,
              providerProfileId: form.providerProfileId || undefined,
              defaultModel: form.defaultModel.trim(),
            };
      const res = await apiFetch(cat ? `/api/cats/${cat.id}` : '/api/cats', {
        method: cat ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((payload.error as string) ?? `保存失败 (${res.status})`);
        return;
      }
      if (cat && strategyForm?.sessionChainEnabled) {
        const strategyRes = await apiFetch(`/api/config/session-strategy/${cat.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildStrategyPayload(strategyForm)),
        });
        if (!strategyRes.ok) {
          const payload = (await strategyRes.json().catch(() => ({}))) as Record<string, unknown>;
          setError((payload.error as string) ?? `Session 策略保存失败 (${strategyRes.status})`);
          return;
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
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center px-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl max-h-[85vh] overflow-y-auto"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-base font-semibold text-gray-900">{cat ? '成员配置' : '添加成员'}</h3>
            <p className="text-xs text-gray-500 mt-1">运行时修改会即时写入 `.cat-cafe/cat-catalog.json`。</p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="关闭">
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {!cat ? (
              <label className="text-sm text-gray-700 space-y-1">
                <span className="font-medium">Cat ID</span>
                <input
                  aria-label="Cat ID"
                  value={form.catId}
                  onChange={(event) => setForm((prev) => ({ ...prev, catId: event.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
            ) : null}
            <label className="text-sm text-gray-700 space-y-1">
              <span className="font-medium">Name</span>
              <input
                aria-label="Name"
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm text-gray-700 space-y-1">
              <span className="font-medium">Display Name</span>
              <input
                aria-label="Display Name"
                value={form.displayName}
                onChange={(event) => setForm((prev) => ({ ...prev, displayName: event.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm text-gray-700 space-y-1">
              <span className="font-medium">Avatar</span>
              <input
                aria-label="Avatar"
                value={form.avatar}
                onChange={(event) => setForm((prev) => ({ ...prev, avatar: event.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm text-gray-700 space-y-1">
              <span className="font-medium">Primary Color</span>
              <input
                aria-label="Primary Color"
                value={form.colorPrimary}
                onChange={(event) => setForm((prev) => ({ ...prev, colorPrimary: event.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm text-gray-700 space-y-1">
              <span className="font-medium">Secondary Color</span>
              <input
                aria-label="Secondary Color"
                value={form.colorSecondary}
                onChange={(event) => setForm((prev) => ({ ...prev, colorSecondary: event.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
          </div>

          <label className="block text-sm text-gray-700 space-y-1">
            <span className="font-medium">Description</span>
            <input
              aria-label="Description"
              value={form.roleDescription}
              onChange={(event) => setForm((prev) => ({ ...prev, roleDescription: event.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>

          <label className="block text-sm text-gray-700 space-y-1">
            <span className="font-medium">Personality</span>
            <input
              aria-label="Personality"
              value={form.personality}
              onChange={(event) => setForm((prev) => ({ ...prev, personality: event.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>

          <label className="block text-sm text-gray-700 space-y-1">
            <span className="font-medium">Aliases</span>
            <textarea
              aria-label="Aliases"
              value={form.mentionPatterns}
              onChange={(event) => setForm((prev) => ({ ...prev, mentionPatterns: event.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm min-h-[72px]"
            />
          </label>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <label className="text-sm text-gray-700 space-y-1">
              <span className="font-medium">Client</span>
              <select
                aria-label="Client"
                value={form.client}
                onChange={(event) => setForm((prev) => ({ ...prev, client: event.target.value as ClientValue }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                {CLIENT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {form.client === 'antigravity' ? (
              <>
                <label className="md:col-span-2 text-sm text-gray-700 space-y-1">
                  <span className="font-medium">CLI Command</span>
                  <input
                    aria-label="CLI Command"
                    value={form.commandArgs}
                    onChange={(event) => setForm((prev) => ({ ...prev, commandArgs: event.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="text-sm text-gray-700 space-y-1">
                  <span className="font-medium">Model</span>
                  <input
                    aria-label="Model"
                    value={form.defaultModel}
                    onChange={(event) => setForm((prev) => ({ ...prev, defaultModel: event.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="text-sm text-gray-700 space-y-1">
                  <span className="font-medium">Provider</span>
                  <select
                    aria-label="Provider"
                    value={form.providerProfileId}
                    onChange={(event) => setForm((prev) => ({ ...prev, providerProfileId: event.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    disabled={loadingProfiles || availableProfiles.length === 0}
                  >
                    <option value="">未绑定</option>
                    {availableProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm text-gray-700 space-y-1">
                  <span className="font-medium">Model</span>
                  {selectedProfile?.models.length ? (
                    <select
                      aria-label="Model"
                      value={form.defaultModel}
                      onChange={(event) => setForm((prev) => ({ ...prev, defaultModel: event.target.value }))}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    >
                      {selectedProfile.models.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label="Model"
                      value={form.defaultModel}
                      onChange={(event) => setForm((prev) => ({ ...prev, defaultModel: event.target.value }))}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  )}
                </label>
              </>
            )}
          </div>

          <section className="rounded-xl border border-gray-200 bg-gray-50/60 p-4 space-y-3">
            <div>
              <h4 className="text-sm font-semibold text-gray-900">Runtime Budget</h4>
              <p className="text-xs text-gray-500 mt-1">
                上下文预算会随成员配置一起持久化到运行时 catalog。4 项要么全部留空，要么全部填写。
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="text-sm text-gray-700 space-y-1">
                <span className="font-medium">Max Prompt Tokens</span>
                <input
                  aria-label="Max Prompt Tokens"
                  value={form.maxPromptTokens}
                  onChange={(event) => setForm((prev) => ({ ...prev, maxPromptTokens: event.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  inputMode="numeric"
                />
              </label>
              <label className="text-sm text-gray-700 space-y-1">
                <span className="font-medium">Max Context Tokens</span>
                <input
                  aria-label="Max Context Tokens"
                  value={form.maxContextTokens}
                  onChange={(event) => setForm((prev) => ({ ...prev, maxContextTokens: event.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  inputMode="numeric"
                />
              </label>
              <label className="text-sm text-gray-700 space-y-1">
                <span className="font-medium">Max Messages</span>
                <input
                  aria-label="Max Messages"
                  value={form.maxMessages}
                  onChange={(event) => setForm((prev) => ({ ...prev, maxMessages: event.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  inputMode="numeric"
                />
              </label>
              <label className="text-sm text-gray-700 space-y-1">
                <span className="font-medium">Max Content Length</span>
                <input
                  aria-label="Max Content Length"
                  value={form.maxContentLengthPerMsg}
                  onChange={(event) => setForm((prev) => ({ ...prev, maxContentLengthPerMsg: event.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  inputMode="numeric"
                />
              </label>
            </div>
          </section>

          {cat ? (
            <section className="rounded-xl border border-gray-200 bg-gray-50/60 p-4 space-y-3">
              <div>
                <h4 className="text-sm font-semibold text-gray-900">Session Strategy</h4>
                <p className="text-xs text-gray-500 mt-1">沿用现有运行时策略覆盖接口，成员详情页直接编辑。</p>
              </div>

              {loadingStrategy ? <p className="text-sm text-gray-400">Session 策略加载中...</p> : null}
              {strategyError ? <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{strategyError}</p> : null}

              {!loadingStrategy && strategyForm ? (
                strategyForm.sessionChainEnabled ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <label className="text-sm text-gray-700 space-y-1">
                      <span className="font-medium">Session Strategy</span>
                      <select
                        aria-label="Session Strategy"
                        value={strategyForm.strategy}
                        onChange={(event) =>
                          setStrategyForm((prev) =>
                            prev ? { ...prev, strategy: event.target.value as StrategyType } : prev,
                          )
                        }
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                      >
                        <option value="handoff">handoff</option>
                        <option value="compress">compress</option>
                        {strategyForm.hybridCapable ? <option value="hybrid">hybrid</option> : null}
                      </select>
                    </label>
                    <label className="text-sm text-gray-700 space-y-1">
                      <span className="font-medium">Warn Threshold</span>
                      <input
                        aria-label="Warn Threshold"
                        value={strategyForm.warnThreshold}
                        onChange={(event) =>
                          setStrategyForm((prev) => (prev ? { ...prev, warnThreshold: event.target.value } : prev))
                        }
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                        inputMode="decimal"
                      />
                    </label>
                    <label className="text-sm text-gray-700 space-y-1">
                      <span className="font-medium">Action Threshold</span>
                      <input
                        aria-label="Action Threshold"
                        value={strategyForm.actionThreshold}
                        onChange={(event) =>
                          setStrategyForm((prev) => (prev ? { ...prev, actionThreshold: event.target.value } : prev))
                        }
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                        inputMode="decimal"
                      />
                    </label>
                    {strategyForm.strategy === 'hybrid' ? (
                      <label className="text-sm text-gray-700 space-y-1">
                        <span className="font-medium">Max Compressions</span>
                        <input
                          aria-label="Max Compressions"
                          value={strategyForm.maxCompressions}
                          onChange={(event) =>
                            setStrategyForm((prev) => (prev ? { ...prev, maxCompressions: event.target.value } : prev))
                          }
                          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                          inputMode="numeric"
                        />
                      </label>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">当前成员未启用 session chain，策略编辑不可用。</p>
                )
              ) : null}
            </section>
          ) : null}

          {error ? <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p> : null}
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-100 bg-gray-50">
          <div className="text-xs text-gray-500">
            {loadingProfiles ? <span>账号配置加载中…</span> : null}
            {loadingProfiles && loadingStrategy ? <span className="mx-1">·</span> : null}
            {loadingStrategy ? <span>Session 策略加载中…</span> : null}
          </div>
          <div className="flex gap-2">
            {cat ? (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="px-3 py-2 text-sm rounded-lg bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50"
              >
                删除成员
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-sm rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-2 text-sm rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
