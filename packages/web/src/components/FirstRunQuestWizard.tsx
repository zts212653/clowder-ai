'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { ClientStep, type DetectedClient } from './first-run-quest/ClientStep';
import { ConfigStep } from './first-run-quest/ConfigStep';
import { type TemplateCard, TemplateStep } from './first-run-quest/TemplateStep';

type WizardStep = 'template' | 'client' | 'config' | 'creating' | 'done';

interface FirstRunQuestWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: (questThreadId: string, catName: string) => void;
}

const STEP_TITLES: Record<WizardStep, string> = {
  template: '第 1 步 — 选择角色模板',
  client: '第 2 步 — 选择客户端',
  config: '第 3 步 — 配置认证和模型',
  creating: '创建中...',
  done: '完成！',
};

export function FirstRunQuestWizard({ open, onClose, onCreated }: FirstRunQuestWizardProps) {
  const { refresh } = useCatData();
  const [step, setStep] = useState<WizardStep>('template');
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateCard | null>(null);
  const [selectedClient, setSelectedClient] = useState<DetectedClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Track created cat to avoid orphans on thread-creation retry
  const createdCatRef = useRef<{ id: string; name: string } | null>(null);

  // Reset wizard state when reopening modal
  useEffect(() => {
    if (open) {
      setStep('template');
      setSelectedTemplate(null);
      setSelectedClient(null);
      setError(null);
      createdCatRef.current = null;
    }
  }, [open]);

  const handleTemplateSelect = useCallback((template: TemplateCard) => {
    setSelectedTemplate(template);
    createdCatRef.current = null; // invalidate — inputs changed
    setStep('client');
  }, []);

  const handleClientSelect = useCallback((client: DetectedClient) => {
    setSelectedClient(client);
    createdCatRef.current = null; // invalidate — inputs changed
    setStep('config');
  }, []);

  const handleConfigComplete = useCallback(
    async (config: { accountRef: string; model: string }) => {
      if (!selectedTemplate || !selectedClient) return;
      setStep('creating');
      setError(null);
      try {
        // Reuse previously created cat if thread creation failed on a prior attempt
        let createdCatId: string;
        let createdCatName: string;

        if (createdCatRef.current) {
          createdCatId = createdCatRef.current.id;
          createdCatName = createdCatRef.current.name;
          // Reconcile config: if user changed accountRef/model since the cat was
          // created, PATCH the existing cat so the bound config stays in sync.
          const patchRes = await apiFetch(`/api/cats/${encodeURIComponent(createdCatId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              accountRef: config.accountRef,
              defaultModel: config.model,
            }),
          });
          if (!patchRes.ok) throw new Error('猫猫配置更新失败');
        } else {
          const suffix = Date.now().toString(36).slice(-4);
          const catId = `${selectedTemplate.id}-${suffix}`;
          const catName = selectedTemplate.nickname ?? selectedTemplate.name;

          const createRes = await apiFetch('/api/cats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              catId,
              name: selectedTemplate.name,
              displayName: selectedTemplate.name,
              nickname: selectedTemplate.nickname,
              avatar: selectedTemplate.avatar,
              color: selectedTemplate.color,
              mentionPatterns: [
                ...(selectedTemplate.nickname ? [`@${selectedTemplate.nickname}`] : []),
                `@${selectedTemplate.name}`,
              ],
              roleDescription: selectedTemplate.roleDescription,
              personality: selectedTemplate.personality,
              teamStrengths: selectedTemplate.teamStrengths,
              clientId: selectedClient.provider,
              accountRef: config.accountRef,
              defaultModel: config.model,
            }),
          });

          if (!createRes.ok) {
            const body = (await createRes.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? `创建失败 (${createRes.status})`);
          }

          const catBody = (await createRes.json()) as { cat?: { id: string; displayName: string } };
          createdCatId = catBody.cat?.id ?? catId;
          createdCatName = catBody.cat?.displayName ?? catName;
          createdCatRef.current = { id: createdCatId, name: createdCatName };

          await refresh();
        }

        // Create bootcamp thread at phase-1-intro (wizard already handled cat selection).
        const bootcampRes = await apiFetch('/api/threads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: '🎓 猫猫训练营',
            bootcampState: {
              v: 1,
              phase: 'phase-1-intro',
              leadCat: createdCatId,
              startedAt: Date.now(),
            },
          }),
        });

        if (!bootcampRes.ok) {
          throw new Error('创建训练营线程失败');
        }

        const thread = (await bootcampRes.json()) as { id: string };

        setStep('done');
        onCreated(thread.id, createdCatName);
      } catch (err) {
        setError(err instanceof Error ? err.message : '创建失败');
        setStep('config');
      }
    },
    [selectedTemplate, selectedClient, onCreated, refresh],
  );

  if (!open) return null;

  const canGoBack = step === 'client' || step === 'config';

  const handleBack = () => {
    if (step === 'config') setStep('client');
    else if (step === 'client') setStep('template');
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-2xl border border-amber-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-amber-100 px-6 py-4">
          <div className="flex items-center gap-3">
            {canGoBack && (
              <button type="button" onClick={handleBack} className="text-sm text-gray-400 hover:text-gray-600">
                ← 上一步
              </button>
            )}
            <h3 className="text-base font-semibold text-gray-900">{STEP_TITLES[step]}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xl leading-none text-gray-400 hover:text-gray-600"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {error && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
          )}

          {step === 'template' && <TemplateStep onSelect={handleTemplateSelect} />}
          {step === 'client' && <ClientStep onSelect={handleClientSelect} />}
          {step === 'config' && selectedClient && (
            <ConfigStep
              client={selectedClient.client}
              clientId={selectedClient.provider}
              onComplete={handleConfigComplete}
            />
          )}
          {step === 'creating' && (
            <div className="flex flex-col items-center py-12">
              <div className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-amber-300 border-t-amber-600" />
              <p className="text-sm text-gray-500">正在创建你的第一只猫猫...</p>
            </div>
          )}
          {step === 'done' && (
            <div className="flex flex-col items-center py-12">
              <div className="mb-3 text-4xl">🎉</div>
              <p className="text-base font-semibold text-gray-900">猫猫已就位！</p>
              <p className="mt-1 text-sm text-gray-500">正在跳转到教程线程...</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
