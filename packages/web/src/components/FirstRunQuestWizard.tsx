'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { ClientStep, type DetectedClient } from './first-run-quest/ClientStep';
import { ConfigStep } from './first-run-quest/ConfigStep';
import { DemoStep } from './first-run-quest/DemoStep';
import { nextDemoScene } from './first-run-quest/demo-script';
import {
  buildRealMembers,
  canContinueClientSetup,
  createJourneyState,
  type OnboardingJourneyState,
  restoreJourneyState,
  stableOnboardingMemberId,
} from './first-run-quest/onboarding-journey';
import {
  STORAGE_KEY,
  setupDraftForTemplate,
  stepForJourneyStage,
  updateJourney,
  type WizardStep,
} from './first-run-quest/onboarding-storage';
import { type TemplateCard, TemplateStep } from './first-run-quest/TemplateStep';

interface FirstRunQuestWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: (questThreadId: string, catName: string) => void;
}

export function FirstRunQuestWizard({ open, onClose, onCreated }: FirstRunQuestWizardProps) {
  const { refresh } = useCatData();
  const [step, setStep] = useState<WizardStep>('demo');
  const [journey, setJourney] = useState<OnboardingJourneyState>(() => createJourneyState());
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateCard | null>(null);
  const [selectedClients, setSelectedClients] = useState<DetectedClient[]>([]);
  const [configIndex, setConfigIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const createdCatsRef = useRef<Map<string, { id: string; name: string }>>(new Map());
  const configsRef = useRef<Map<string, { accountRef: string; model: string }>>(new Map());

  useEffect(() => {
    if (!open) return;
    let restored: OnboardingJourneyState | null = null;
    try {
      restored = restoreJourneyState(localStorage.getItem(STORAGE_KEY));
    } catch {
      /* Storage may be disabled. */
    }
    const next = restored ?? createJourneyState();
    setJourney(next);
    setStep(stepForJourneyStage(next));
    setSelectedTemplate(next.setup?.template ?? null);
    setSelectedClients(next.setup?.clients ?? []);
    setConfigIndex(next.setup?.configIndex ?? 0);
    setError(null);
    createdCatsRef.current = new Map();
    configsRef.current = new Map(Object.entries(next.setup?.configs ?? {}));
  }, [open]);

  const advanceDemo = useCallback(() => {
    setJourney((current) => {
      if (current.demoPaused) return current;
      const scene = nextDemoScene(current.demoScene);
      const next = updateJourney(current, {
        demoScene: scene,
        stage: scene === 'handoff' ? 'handoff' : 'demo',
        demoCompletedAt: scene === 'handoff' ? Date.now() : current.demoCompletedAt,
      });
      if (scene === 'handoff') setStep('template');
      return next;
    });
  }, []);

  const toggleDemoPause = useCallback(() => {
    setJourney((current) => updateJourney(current, { demoPaused: !current.demoPaused }));
  }, []);

  const handleTemplateSelect = useCallback((template: TemplateCard) => {
    setSelectedTemplate(template);
    setJourney((current) => setupDraftForTemplate(current, template));
    configsRef.current = new Map();
    createdCatsRef.current = new Map();
    setStep('client');
  }, []);

  const handleClientSelect = useCallback(
    (clients: DetectedClient[]) => {
      if (!canContinueClientSetup(clients)) return;
      const configs = Object.fromEntries(
        clients.flatMap((client) => {
          const config = journey.setup?.configs[client.client];
          return config ? [[client.client, config]] : [];
        }),
      );
      const missingIndex = clients.findIndex((client) => !configs[client.client]);
      const nextIndex = missingIndex < 0 ? clients.length - 1 : missingIndex;
      setSelectedClients(clients);
      setJourney((current) =>
        updateJourney(current, {
          stage: 'setup',
          realMembers: buildRealMembers(clients),
          setup: { ...current.setup, step: 'config', clients, configs, configIndex: nextIndex },
        }),
      );
      configsRef.current = new Map(Object.entries(configs));
      createdCatsRef.current = new Map();
      setConfigIndex(nextIndex);
      setStep('config');
    },
    [journey.setup],
  );

  const goBack = () => {
    const nextStep = step === 'config' ? 'client' : step === 'client' ? 'template' : 'demo';
    setStep(nextStep);
    setJourney((current) =>
      updateJourney(current, {
        stage: nextStep === 'client' ? 'setup' : nextStep === 'template' ? 'handoff' : 'demo',
        setup: current.setup ? { ...current.setup, step: 'client' } : undefined,
      }),
    );
  };

  const currentClient = selectedClients[configIndex];
  const createCat = useCallback(
    async (client: DetectedClient, config: { accountRef: string; model: string }) => {
      if (!selectedTemplate) throw new Error('请先选择角色模板');
      const existing = createdCatsRef.current.get(client.client);
      if (existing) return existing;
      const catId = stableOnboardingMemberId(journey.journeyId, selectedTemplate.id, client.client);
      const catName = `${selectedTemplate.name} · ${client.label}`;
      const nickname = selectedTemplate.nickname ? `${selectedTemplate.nickname} · ${client.label}` : undefined;
      const response = await apiFetch('/api/cats', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Cat-Cafe-Onboarding-Journey': journey.journeyId,
          'Idempotency-Key': `onboarding:${journey.journeyId}:cat:${client.client}`,
        },
        body: JSON.stringify({
          catId,
          name: catName,
          displayName: catName,
          nickname,
          avatar: selectedTemplate.avatar,
          color: selectedTemplate.color,
          mentionPatterns: [...new Set([`@${catName}`, ...(nickname ? [`@${nickname}`] : [])])],
          roleDescription: selectedTemplate.roleDescription,
          personality: selectedTemplate.personality,
          teamStrengths: selectedTemplate.teamStrengths,
          clientId: client.provider,
          accountRef: config.accountRef,
          defaultModel: config.model,
        }),
      });
      if (!response.ok) throw new Error(`创建 ${client.label} 失败 (${response.status})`);
      const body = (await response.json()) as { cat?: { id: string; displayName: string } };
      const created = { id: body.cat?.id ?? catId, name: body.cat?.displayName ?? catName };
      createdCatsRef.current.set(client.client, created);
      return created;
    },
    [journey.journeyId, selectedTemplate],
  );

  const handleConfigComplete = useCallback(
    async (config: { accountRef: string; model: string }) => {
      if (!currentClient) return;
      setError(null);
      configsRef.current.set(currentClient.client, config);
      setJourney((current) =>
        updateJourney(current, {
          setup: current.setup
            ? {
                ...current.setup,
                configs: { ...current.setup.configs, [currentClient.client]: config },
                configIndex: configIndex < selectedClients.length - 1 ? configIndex + 1 : configIndex,
              }
            : undefined,
        }),
      );

      if (configIndex < selectedClients.length - 1) {
        setConfigIndex((index) => index + 1);
        return;
      }

      if (!canContinueClientSetup(selectedClients) || configsRef.current.size !== selectedClients.length) {
        setError('请先完成所有客户端的安装、登录和配置');
        setStep('client');
        return;
      }

      setStep('creating');
      try {
        for (const client of selectedClients) {
          const clientConfig = configsRef.current.get(client.client);
          if (!clientConfig) throw new Error(`缺少 ${client.label} 的配置`);
          await createCat(client, clientConfig);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '创建成员失败');
        setStep('config');
        return;
      }
      try {
        await refresh();
        const response = await apiFetch('/api/threads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Cat-Cafe-Onboarding-Journey': journey.journeyId,
            'Idempotency-Key': `onboarding:${journey.journeyId}:thread`,
          },
          body: JSON.stringify({
            title: '首启协作旅程',
            bootcampState: {
              v: 1,
              phase: 'phase-1-intro',
              leadCat: createdCatsRef.current.get(selectedClients[0]?.client ?? '')?.id,
              startedAt: Date.now(),
              journeyId: journey.journeyId,
            },
          }),
        });
        if (!response.ok) throw new Error('创建协作线程失败');
        const thread = (await response.json()) as { id: string };
        setJourney((current) =>
          updateJourney(current, {
            stage: 'ready',
            threadId: thread.id,
            realMembers: buildRealMembers(selectedClients),
          }),
        );
        setStep('done');
        onCreated(thread.id, createdCatsRef.current.get(selectedClients[0]?.client ?? '')?.name ?? '你的团队');
      } catch (err) {
        setError(err instanceof Error ? err.message : '创建失败');
        setStep('config');
      }
    },
    [configIndex, createCat, currentClient, journey.journeyId, onCreated, refresh, selectedClients],
  );

  const title = useMemo(() => {
    if (step === 'demo') return '认识你的协作团队';
    if (step === 'template') return '选择团队角色';
    if (step === 'client') return '选择协作客户端';
    if (step === 'config') return `配置 ${currentClient?.label ?? '客户端'}`;
    if (step === 'creating') return '正在创建团队';
    return '团队已就绪';
  }, [currentClient?.label, step]);

  if (!open) return null;
  const canGoBack = step === 'template' || step === 'client' || step === 'config';

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--console-overlay-medium)] px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-2xl border border-conn-amber-ring bg-[var(--console-card-bg)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--semantic-warning-surface)] px-6 py-4">
          <div className="flex items-center gap-3">
            {canGoBack && (
              <button type="button" onClick={goBack} className="text-sm text-cafe-muted hover:text-cafe-secondary">
                返回
              </button>
            )}
            <h3 className="text-base font-semibold text-cafe">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xl leading-none text-cafe-muted hover:text-cafe-secondary"
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {error && (
            <div className="mb-3 rounded-lg border border-conn-red-ring bg-conn-red-bg p-3 text-sm text-conn-red-text">
              {error}
            </div>
          )}
          {step === 'demo' && <DemoStep journey={journey} onPause={toggleDemoPause} onAdvance={advanceDemo} />}
          {step === 'template' && <TemplateStep onSelect={handleTemplateSelect} />}
          {step === 'client' && (
            <ClientStep
              savedClients={journey.setup?.detectedClients ?? journey.setup?.clients}
              onClientsChange={(clients) =>
                setJourney((current) =>
                  updateJourney(current, {
                    setup: current.setup ? { ...current.setup, detectedClients: clients } : undefined,
                  }),
                )
              }
              onSelect={handleClientSelect}
            />
          )}
          {step === 'config' && currentClient && (
            <ConfigStep
              key={currentClient.client}
              client={currentClient.client}
              clientId={currentClient.provider}
              detectedAuth={
                currentClient.authType === 'environment'
                  ? 'environment'
                  : currentClient.authenticated && !currentClient.hasApiKey
                    ? 'oauth'
                    : false
              }
              initialConfig={journey.setup?.configs[currentClient.client]}
              onComplete={handleConfigComplete}
            />
          )}
          {step === 'creating' && (
            <div className="flex flex-col items-center py-12">
              <div className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-conn-amber-ring border-t-amber-600" />
              <p className="text-sm text-cafe-muted">正在创建你的真实团队...</p>
            </div>
          )}
          {step === 'done' && (
            <div className="space-y-3 py-10 text-center">
              <div className="text-4xl">🎉</div>
              <p className="text-base font-semibold text-cafe">团队已就绪</p>
              <p className="text-sm text-cafe-muted">发送第一条真实消息，开始你的协作旅程。</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
