export type OnboardingAuthStatus = 'ready' | 'login_required' | 'pending' | 'not_installed';

export interface OnboardingClient {
  client: string;
  label: string;
  installed: boolean;
  authStatus: OnboardingAuthStatus;
  provider?: string;
}

export interface OnboardingRealMember {
  client: string;
  label: string;
  isReal: true;
  provider?: string;
}

export interface OnboardingTemplateDraft {
  id: string;
  name: string;
  nickname?: string;
  avatar: string;
  color: { primary: string; secondary: string };
  roleDescription: string;
  personality: string;
  teamStrengths?: string;
}

export interface OnboardingClientDraft {
  client: string;
  provider: string;
  label: string;
  cli: string;
  installed: boolean;
  version?: string;
  hasApiKey: boolean;
  authenticated?: boolean;
  authStatus: OnboardingAuthStatus;
  authType?: 'environment' | 'native' | 'none';
  accountRef?: string;
}

export interface OnboardingConfigDraft {
  accountRef: string;
  model: string;
}

export interface OnboardingSetupDraft {
  template?: OnboardingTemplateDraft;
  step?: 'client' | 'config';
  detectedClients?: OnboardingClientDraft[];
  clients: OnboardingClientDraft[];
  configs: Record<string, OnboardingConfigDraft>;
  configIndex: number;
}

export type OnboardingStage = 'demo' | 'handoff' | 'setup' | 'ready' | 'complete';
export type DemoScene = 'opening' | 'draft' | 'review' | 'improved' | 'handoff';

export interface OnboardingJourneyState {
  version: 1;
  /** Stable client-generated identity for retries and refresh recovery. */
  journeyId: string;
  stage: OnboardingStage;
  demoParticipants: readonly string[];
  demoScene: DemoScene;
  demoPaused: boolean;
  demoCompletedAt?: number;
  realMembers: OnboardingRealMember[];
  setup?: OnboardingSetupDraft;
  threadId?: string;
  completedAt?: number;
}

const DEMO_PARTICIPANTS = ['规划猫', '实现猫', '审查猫'] as const;

export function createJourneyState(): OnboardingJourneyState {
  return {
    version: 1,
    journeyId: createJourneyId(),
    stage: 'demo',
    demoParticipants: [...DEMO_PARTICIPANTS],
    demoScene: 'opening',
    demoPaused: false,
    realMembers: [],
  };
}

function createJourneyId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `journey-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function stableOnboardingMemberId(journeyId: string, templateId: string, client: string): string {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  return `${normalize(templateId) || 'member'}-${normalize(journeyId).slice(0, 24)}-${normalize(client) || 'client'}`;
}

export function canContinueClientSetup(clients: readonly OnboardingClient[]): boolean {
  return clients.length > 0 && clients.every((client) => client.installed && client.authStatus === 'ready');
}

export function mergeDetectedAuthStatus(
  derived: OnboardingAuthStatus,
  saved?: OnboardingAuthStatus,
): OnboardingAuthStatus {
  if (derived === 'ready') return 'ready';
  if (derived === 'not_installed') return 'not_installed';
  if (saved === 'pending') return 'pending';
  return derived;
}

export function buildRealMembers(clients: readonly OnboardingClient[]): OnboardingRealMember[] {
  const seen = new Set<string>();
  return clients
    .filter((client) => client.installed && client.authStatus === 'ready')
    .filter((client) => {
      if (seen.has(client.client)) return false;
      seen.add(client.client);
      return true;
    })
    .map((client) => ({
      client: client.client,
      label: client.label,
      isReal: true as const,
      ...(client.provider ? { provider: client.provider } : {}),
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStage(value: unknown): value is OnboardingStage {
  return value === 'demo' || value === 'handoff' || value === 'setup' || value === 'ready' || value === 'complete';
}

function isDemoScene(value: unknown): value is DemoScene {
  return value === 'opening' || value === 'draft' || value === 'review' || value === 'improved' || value === 'handoff';
}

function isRealMember(value: unknown): value is OnboardingRealMember {
  return (
    isRecord(value) &&
    typeof value.client === 'string' &&
    typeof value.label === 'string' &&
    value.isReal === true &&
    (value.provider === undefined || typeof value.provider === 'string')
  );
}

function isTemplateDraft(value: unknown): value is OnboardingTemplateDraft {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.nickname === undefined || typeof value.nickname === 'string') &&
    typeof value.avatar === 'string' &&
    isRecord(value.color) &&
    typeof value.color.primary === 'string' &&
    typeof value.color.secondary === 'string' &&
    typeof value.roleDescription === 'string' &&
    typeof value.personality === 'string' &&
    (value.teamStrengths === undefined || typeof value.teamStrengths === 'string')
  );
}

function isClientDraft(value: unknown): value is OnboardingClientDraft {
  return (
    isRecord(value) &&
    typeof value.client === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.label === 'string' &&
    typeof value.cli === 'string' &&
    typeof value.installed === 'boolean' &&
    (value.version === undefined || typeof value.version === 'string') &&
    typeof value.hasApiKey === 'boolean' &&
    (value.authenticated === undefined || typeof value.authenticated === 'boolean') &&
    (value.authType === undefined ||
      value.authType === 'environment' ||
      value.authType === 'native' ||
      value.authType === 'none') &&
    (value.accountRef === undefined || typeof value.accountRef === 'string') &&
    (value.authStatus === 'ready' ||
      value.authStatus === 'login_required' ||
      value.authStatus === 'pending' ||
      value.authStatus === 'not_installed')
  );
}

function isConfigDraft(value: unknown): value is OnboardingConfigDraft {
  return isRecord(value) && typeof value.accountRef === 'string' && typeof value.model === 'string';
}

function isSetupDraft(value: unknown): value is OnboardingSetupDraft {
  if (!isRecord(value) || !Array.isArray(value.clients) || !value.clients.every(isClientDraft)) return false;
  if (!isRecord(value.configs) || !Object.values(value.configs).every(isConfigDraft)) return false;
  return (
    (value.template === undefined || isTemplateDraft(value.template)) &&
    (value.step === undefined || value.step === 'client' || value.step === 'config') &&
    (value.detectedClients === undefined ||
      (Array.isArray(value.detectedClients) && value.detectedClients.every(isClientDraft))) &&
    typeof value.configIndex === 'number' &&
    Number.isInteger(value.configIndex) &&
    value.configIndex >= 0 &&
    value.configIndex <= value.clients.length
  );
}

export function restoreJourneyState(serialized: string | null | undefined): OnboardingJourneyState | null {
  if (!serialized) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== 1 || !isStage(parsed.stage)) return null;
    if (typeof parsed.journeyId !== 'string' || parsed.journeyId.trim().length < 8) return null;
    if (!Array.isArray(parsed.demoParticipants) || !parsed.demoParticipants.every((item) => typeof item === 'string')) {
      return null;
    }
    if (!isDemoScene(parsed.demoScene) || typeof parsed.demoPaused !== 'boolean') return null;
    if (!Array.isArray(parsed.realMembers) || !parsed.realMembers.every(isRealMember)) return null;
    if (parsed.demoCompletedAt !== undefined && typeof parsed.demoCompletedAt !== 'number') return null;
    if (parsed.setup !== undefined && !isSetupDraft(parsed.setup)) return null;
    if (parsed.threadId !== undefined && typeof parsed.threadId !== 'string') return null;
    if (parsed.completedAt !== undefined && typeof parsed.completedAt !== 'number') return null;
    return {
      version: 1,
      journeyId: parsed.journeyId,
      stage: parsed.stage,
      demoParticipants: [...parsed.demoParticipants],
      demoScene: parsed.demoScene,
      demoPaused: parsed.demoPaused,
      ...(parsed.demoCompletedAt === undefined ? {} : { demoCompletedAt: parsed.demoCompletedAt }),
      realMembers: parsed.realMembers.map((member) => ({ ...member })),
      ...(parsed.setup === undefined
        ? {}
        : {
            setup: {
              ...(parsed.setup.step === undefined ? {} : { step: parsed.setup.step }),
              ...(parsed.setup.detectedClients === undefined
                ? {}
                : { detectedClients: parsed.setup.detectedClients.map((client) => ({ ...client })) }),
              ...(parsed.setup.template === undefined
                ? {}
                : { template: { ...parsed.setup.template, color: { ...parsed.setup.template.color } } }),
              clients: parsed.setup.clients.map((client) => ({ ...client })),
              configs: Object.fromEntries(
                Object.entries(parsed.setup.configs).map(([key, config]) => [key, { ...config }]),
              ),
              configIndex: parsed.setup.configIndex,
            },
          }),
      ...(parsed.threadId === undefined ? {} : { threadId: parsed.threadId }),
      ...(parsed.completedAt === undefined ? {} : { completedAt: parsed.completedAt }),
    };
  } catch {
    return null;
  }
}

export function markFirstRealMessage(state: OnboardingJourneyState, timestamp = Date.now()): OnboardingJourneyState {
  if (state.stage !== 'ready' || state.completedAt !== undefined) return state;
  return { ...state, stage: 'complete', completedAt: timestamp };
}

/** Completion is durable only after the hydrated thread and PATCH response agree. */
export function canCommitFirstRealMessage(
  journey: OnboardingJourneyState,
  hydratedThreadState: { journeyId?: string; completedAt?: number } | undefined,
  serverState: { journeyId?: string; completedAt?: number } | undefined,
): boolean {
  return (
    journey.stage === 'ready' &&
    journey.completedAt === undefined &&
    hydratedThreadState?.journeyId === journey.journeyId &&
    hydratedThreadState.completedAt === undefined &&
    serverState?.journeyId === journey.journeyId &&
    serverState.completedAt !== undefined
  );
}

export type FirstRealMessageSyncAction = 'ignore' | 'wait-for-hydration' | 'patch' | 'already-complete';

export interface FirstRealMessagePendingMarker {
  journeyId: string;
  threadId: string;
}

export function restoreFirstRealMessagePendingMarker(
  serialized: string | null | undefined,
): FirstRealMessagePendingMarker | null {
  if (!serialized) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || typeof parsed.journeyId !== 'string' || typeof parsed.threadId !== 'string') return null;
    if (parsed.journeyId.trim().length < 8 || parsed.threadId.trim().length === 0) return null;
    return { journeyId: parsed.journeyId, threadId: parsed.threadId };
  } catch {
    return null;
  }
}

/** Decide what to do when the first real message arrives before thread hydration. */
export function firstRealMessageSyncAction(
  journey: OnboardingJourneyState | null,
  hydratedThreadState: { journeyId?: string; completedAt?: number } | undefined,
): FirstRealMessageSyncAction {
  if (!journey || journey.stage !== 'ready' || journey.completedAt !== undefined) return 'ignore';
  if (!hydratedThreadState) return 'wait-for-hydration';
  if (hydratedThreadState.journeyId !== journey.journeyId) return 'ignore';
  if (hydratedThreadState.completedAt !== undefined) return 'already-complete';
  return 'patch';
}
