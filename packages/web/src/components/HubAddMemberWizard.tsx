'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { filterProfiles, type ClientValue, type HubCatEditorDraft } from './hub-cat-editor.model';
import {
  ChoiceButton,
  CLIENT_ROW_1,
  CLIENT_ROW_2,
  clientLabel,
  FALLBACK_ANTIGRAVITY_ARGS,
  TEMPLATE_ANTIGRAVITY_MODELS,
} from './hub-add-member-wizard.parts';
import type { ProfileItem, ProviderProfilesResponse } from './hub-provider-profiles.types';

interface HubAddMemberWizardProps {
  open: boolean;
  onClose: () => void;
  onComplete: (draft: HubCatEditorDraft) => void;
}

export function HubAddMemberWizard({ open, onClose, onComplete }: HubAddMemberWizardProps) {
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<ClientValue | null>(null);
  const [providerProfileId, setProviderProfileId] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [commandArgs, setCommandArgs] = useState(FALLBACK_ANTIGRAVITY_ARGS);

  const antigravityDefaults = useMemo(
    (): { command: string; models: string[] } => ({
      command: FALLBACK_ANTIGRAVITY_ARGS,
      models: [...TEMPLATE_ANTIGRAVITY_MODELS],
    }),
    [],
  );

  const availableProfiles = useMemo(
    () => (client ? filterProfiles(client, profiles) : []),
    [client, profiles],
  );
  const selectedProfile = useMemo(
    () => availableProfiles.find((profile) => profile.id === providerProfileId) ?? null,
    [availableProfiles, providerProfileId],
  );
  const selectableModels = useMemo(() => {
    if (client === 'antigravity') return antigravityDefaults.models;
    return selectedProfile?.models ?? [];
  }, [antigravityDefaults.models, client, selectedProfile?.models]);

  function profileSubtitle(profile: ProfileItem) {
    if (profile.builtin && profile.authType === 'oauth') {
      return '内置订阅账号；Claude / Codex / Gemini 可直接复用，Dare / OpenCode 视作 OAuth-like 兼容账号';
    }
    if (profile.authType === 'api_key') {
      return 'API Key 账号；Claude / Codex / Gemini 也可直接绑定，不受内置 OAuth 限制';
    }
    return '选择具体账号后，再从该账号可用模型中继续创建';
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    setClient(null);
    setProviderProfileId('');
    setDefaultModel('');
    setCommandArgs(antigravityDefaults.command);
  }, [open, antigravityDefaults.command]);

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
    if (!client || client === 'antigravity') return;
    if (availableProfiles.some((profile) => profile.id === providerProfileId)) return;
    setProviderProfileId('');
    setDefaultModel('');
  }, [availableProfiles, client, providerProfileId]);

  useEffect(() => {
    if (client !== 'antigravity') return;
    if (defaultModel.trim()) return;
    setDefaultModel(antigravityDefaults.models[0] ?? '');
  }, [antigravityDefaults.models, client, defaultModel]);

  if (!open) return null;

  const canFinish = Boolean(
    client &&
      defaultModel.trim() &&
      (client === 'antigravity' ? commandArgs.trim().length > 0 : providerProfileId.trim().length > 0),
  );

  const handleClientSelect = (nextClient: ClientValue) => {
    setClient(nextClient);
    setProviderProfileId('');
    setDefaultModel(nextClient === 'antigravity' ? antigravityDefaults.models[0] ?? '' : '');
    setCommandArgs(antigravityDefaults.command);
  };

  const handleProviderSelect = (nextProviderId: string) => {
    setProviderProfileId(nextProviderId);
    const nextProfile = availableProfiles.find((profile) => profile.id === nextProviderId) ?? null;
    setDefaultModel(nextProfile?.models[0] ?? '');
  };

  const handleComplete = () => {
    if (!client || !defaultModel.trim()) return;
    if (client === 'antigravity') {
      onComplete({
        client,
        defaultModel: defaultModel.trim(),
        commandArgs: commandArgs.trim(),
      });
      return;
    }
    onComplete({
      client,
      providerProfileId,
      defaultModel: defaultModel.trim(),
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div
        className="w-full max-w-[520px] rounded-[32px] border border-[#F0DDCD] bg-[#FFF8F2] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between px-7 pb-1 pt-7">
          <div>
            <p className="text-[13px] font-semibold text-[#D18A61]">成员协作 &gt; 总览 &gt; 添加成员</p>
            <h3 className="mt-2 text-2xl font-bold leading-[1.2] text-[#2D2118]">
              选择 Client + Provider + 模型 → 创建成员（Antigravity 改为 CLI 命令 + 模型）
            </h3>
            <p className="mt-2 text-[15px] leading-6 text-[#8A776B]">
              API Key 凭证在账号配置中管理；普通 Client 在此选择 Provider + 模型。若 Client=Antigravity，则直接配置
              CLI 命令（默认值来自 cat-template）和模型。
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-2xl leading-none text-[#B59A88]" aria-label="关闭">
            ×
          </button>
        </div>

        <div className="space-y-5 px-7 py-6">
          <section className="space-y-4 rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-[18px]">
            <div>
              <h4 className="text-[17px] font-bold text-[#2D2118]">Step 1: 选择 Client</h4>
              <p className="mt-1 text-sm leading-6 text-[#7F7168]">选择要接入的 CLI 工具、Agent 平台或 Antigravity bridge</p>
            </div>
            {[CLIENT_ROW_1, CLIENT_ROW_2].map((row, index) => (
              <div key={index} aria-label={`Client Row ${index + 1}`} className="grid gap-3 sm:grid-cols-3">
                {row.map((value) => (
                  <ChoiceButton
                    key={value}
                    label={clientLabel(value)}
                    selected={client === value}
                    onClick={() => handleClientSelect(value)}
                  />
                ))}
              </div>
            ))}
          </section>

          <section className="space-y-4 rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-[18px]">
            <div>
              <h4 className="text-[17px] font-bold text-[#2D2118]">Step 2: 选择 Provider / 配置 CLI</h4>
              <p className="mt-1 text-sm leading-6 text-[#7F7168]">
                {client === 'antigravity'
                  ? 'Client=Antigravity 时，直接配置 CLI 命令；默认值来自 cat-template。'
                  : 'Claude/Codex/Gemini → 同名 OAuth + 任意 API Key provider；Dare / OpenCode 继续复用协议兼容账号。'}
              </p>
              <p className="mt-2 text-xs font-semibold text-[#B58A6C]">
                Claude/Codex/Gemini → 同名 OAuth + 任意 API Key provider | 其他 Client → 复用兼容账号 | Antigravity → 此步改为配置 CLI 命令
              </p>
            </div>

            {!client ? (
              <p className="rounded-2xl border border-dashed border-[#E8DCCF] bg-white/80 px-4 py-3 text-sm text-[#8A776B]">
                先在 Step 1 选择 Client，Provider / CLI 配置会自动展开。
              </p>
            ) : client === 'antigravity' ? (
              <label className="space-y-1.5 text-sm text-[#5C4B42]">
                <span className="font-medium">CLI Command</span>
                <input
                  aria-label="CLI Command"
                  value={commandArgs}
                  onChange={(event) => setCommandArgs(event.target.value)}
                  className="w-full rounded-xl border border-[#E8DCCF] bg-[#F7F3F0] px-3 py-2.5 text-sm text-[#2D2118] outline-none transition focus:border-[#D49266] focus:ring-2 focus:ring-[#F5D2B8]"
                />
              </label>
            ) : loadingProfiles ? (
              <p className="text-sm text-[#8A776B]">账号配置加载中...</p>
            ) : availableProfiles.length > 0 ? (
              <div className="grid gap-3">
                {availableProfiles.map((profile) => (
                  <ChoiceButton
                    key={profile.id}
                    label={profile.displayName}
                    subtitle={profileSubtitle(profile)}
                    selected={providerProfileId === profile.id}
                    onClick={() => handleProviderSelect(profile.id)}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-2xl border border-[#F1E7DF] bg-white/80 px-4 py-3 text-sm text-[#8A776B]">
                当前 Client 还没有可绑定的 Provider。
              </p>
            )}
          </section>

          <section className="space-y-4 rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-[18px]">
            <div>
              <h4 className="text-[17px] font-bold text-[#2D2118]">Step 3: 选择 Model</h4>
              <p className="mt-1 text-sm leading-6 text-[#7F7168]">完成后自动跳转到成员配置页，可继续调整身份、别名和高级参数。</p>
            </div>

            {!client ? (
              <p className="rounded-2xl border border-dashed border-[#E8DCCF] bg-white/80 px-4 py-3 text-sm text-[#8A776B]">
                先选择 Client，模型列表会跟着 Provider / CLI 配置一起收敛。
              </p>
            ) : client !== 'antigravity' && !providerProfileId ? (
              <p className="rounded-2xl border border-dashed border-[#E8DCCF] bg-white/80 px-4 py-3 text-sm text-[#8A776B]">
                先在 Step 2 选择一个 Provider，再从该账号的可用模型里继续创建成员。
              </p>
            ) : selectableModels.length > 0 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {selectableModels.map((model) => (
                  <ChoiceButton
                    key={model}
                    label={model}
                    selected={defaultModel === model}
                    onClick={() => setDefaultModel(model)}
                  />
                ))}
              </div>
            ) : (
              <label className="space-y-1.5 text-sm text-[#5C4B42]">
                <span className="font-medium">Model</span>
                <input
                  aria-label="Model"
                  value={defaultModel}
                  onChange={(event) => setDefaultModel(event.target.value)}
                  className="w-full rounded-xl border border-[#E8DCCF] bg-[#F7F3F0] px-3 py-2.5 text-sm text-[#2D2118] outline-none transition focus:border-[#D49266] focus:ring-2 focus:ring-[#F5D2B8]"
                />
              </label>
            )}
          </section>

          {error ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p> : null}
        </div>

        <div className="flex items-center justify-between border-t border-[#F0DDCD] bg-[#FFF3EA] px-7 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-white px-4 py-2 text-sm text-[#6A5A50] transition hover:bg-[#F7EEE6]"
          >
            取消
          </button>

          <button
            type="button"
            onClick={handleComplete}
            disabled={!canFinish}
            className="rounded-xl bg-[#D49266] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#C88254] disabled:opacity-50"
          >
            进入成员配置
          </button>
        </div>
      </div>
    </div>
  );
}
