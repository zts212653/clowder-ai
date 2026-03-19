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
  StepBadge,
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
  const [step, setStep] = useState<1 | 2 | 3>(1);
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
  const stepTwoTitle = client === 'antigravity' ? 'Step 2 配置 CLI Command' : 'Step 2 选择 Provider';

  useEffect(() => {
    if (!open) return;
    setError(null);
    setStep(1);
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
    if (availableProfiles.length === 0) {
      setProviderProfileId('');
      return;
    }
    const nextProfile =
      availableProfiles.find((profile) => profile.id === providerProfileId) ?? availableProfiles[0] ?? null;
    if (!nextProfile) return;
    setProviderProfileId(nextProfile.id);
    if (!nextProfile.models.includes(defaultModel)) {
      setDefaultModel(nextProfile.models[0] ?? '');
    }
  }, [availableProfiles, client, defaultModel, providerProfileId]);

  useEffect(() => {
    if (client !== 'antigravity') return;
    if (!antigravityDefaults.models.includes(defaultModel)) {
      setDefaultModel(antigravityDefaults.models[0] ?? '');
    }
  }, [antigravityDefaults.models, client, defaultModel]);

  if (!open) return null;

  const canAdvanceFromStepTwo = client === 'antigravity' ? commandArgs.trim().length > 0 : providerProfileId.length > 0;
  const canFinish = Boolean(client && defaultModel.trim() && (client === 'antigravity' || providerProfileId));

  const handleClientSelect = (nextClient: ClientValue) => {
    setClient(nextClient);
    setProviderProfileId('');
    setDefaultModel('');
    setCommandArgs(antigravityDefaults.command);
    setStep(2);
  };

  const handleProviderSelect = (nextProviderId: string) => {
    setProviderProfileId(nextProviderId);
    const nextProfile = availableProfiles.find((profile) => profile.id === nextProviderId) ?? null;
    setDefaultModel(nextProfile?.models[0] ?? '');
    setStep(3);
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
        className="w-full max-w-2xl rounded-[32px] border border-[#F0DDCD] bg-[#FFF8F2] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-[#F0DDCD] px-7 py-5">
          <div>
            <p className="text-xs font-semibold text-[#77A777]">成员协作 &gt; 总览 &gt; 添加成员</p>
            <h3 className="mt-2 text-2xl font-bold text-[#2D2118]">添加成员流程</h3>
            <p className="mt-1 text-sm text-[#8A776B]">先选运行方式，再进入成员配置页补充身份与路由信息。</p>
          </div>
          <button type="button" onClick={onClose} className="text-2xl leading-none text-[#B59A88]" aria-label="关闭">
            ×
          </button>
        </div>

        <div className="space-y-5 px-7 py-6">
          <div className="flex flex-wrap gap-2">
            <StepBadge active={step === 1} done={step > 1} label="Step 1 Client" />
            <StepBadge active={step === 2} done={step > 2} label="Step 2 Provider / CLI" />
            <StepBadge active={step === 3} done={false} label="Step 3 Model" />
          </div>

          {step === 1 ? (
            <section className="space-y-4 rounded-[24px] border border-[#F1E7DF] bg-[#FFFDFC] p-5">
              <div>
                <h4 className="text-lg font-semibold text-[#2D2118]">Step 1 选择 Client</h4>
                <p className="mt-1 text-sm text-[#8A776B]">普通成员走账号绑定；Antigravity 走桥接 CLI。</p>
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
          ) : null}

          {step === 2 ? (
            <section className="space-y-4 rounded-[24px] border border-[#F1E7DF] bg-[#FFFDFC] p-5">
              <div>
                <h4 className="text-lg font-semibold text-[#2D2118]">{stepTwoTitle}</h4>
                <p className="mt-1 text-sm text-[#8A776B]">
                  {client === 'antigravity'
                    ? '默认值来自 Antigravity 模板。确认后进入模型选择。'
                    : 'Provider 绑定的是具体账号配置，而不是抽象 provider。'}
                </p>
              </div>

              {client === 'antigravity' ? (
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
                <div className="grid gap-3 sm:grid-cols-2">
                  {availableProfiles.map((profile) => (
                    <ChoiceButton
                      key={profile.id}
                      label={profile.displayName}
                      subtitle={`${profile.protocol ?? 'generic'} · ${profile.authType}`}
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
          ) : null}

          {step === 3 ? (
            <section className="space-y-4 rounded-[24px] border border-[#F1E7DF] bg-[#FFFDFC] p-5">
              <div>
                <h4 className="text-lg font-semibold text-[#2D2118]">Step 3 选择 Model</h4>
                <p className="mt-1 text-sm text-[#8A776B]">完成这一步后，会进入成员配置页继续补充身份、别名和高级参数。</p>
              </div>

              {client === 'antigravity' ? (
                antigravityDefaults.models.length > 0 ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {antigravityDefaults.models.map((model) => (
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
                )
              ) : selectedProfile?.models.length ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {selectedProfile.models.map((model) => (
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
          ) : null}

          {error ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p> : null}
        </div>

        <div className="flex items-center justify-between border-t border-[#F0DDCD] bg-[#FFF3EA] px-7 py-4">
          <button
            type="button"
            onClick={step === 1 ? onClose : () => setStep((prev) => (prev === 3 ? 2 : 1))}
            className="rounded-xl bg-white px-4 py-2 text-sm text-[#6A5A50] transition hover:bg-[#F7EEE6]"
          >
            {step === 1 ? '取消' : '上一步'}
          </button>

          <div className="flex gap-2">
            {step === 2 && client === 'antigravity' ? (
              <button
                type="button"
                onClick={() => setStep(3)}
                disabled={!canAdvanceFromStepTwo}
                className="rounded-xl bg-[#D49266] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#C88254] disabled:opacity-50"
              >
                下一步
              </button>
            ) : null}
            {step === 3 ? (
              <button
                type="button"
                onClick={handleComplete}
                disabled={!canFinish}
                className="rounded-xl bg-[#D49266] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#C88254] disabled:opacity-50"
              >
                进入成员配置
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
