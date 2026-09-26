import type { OnboardingJourneyState, OnboardingTemplateDraft } from './onboarding-journey';

export type WizardStep = 'demo' | 'template' | 'client' | 'config' | 'creating' | 'done';

export const STORAGE_KEY = 'cat-cafe:onboarding-journey';

function persistJourney(state: OnboardingJourneyState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage may be unavailable */
  }
}

export function updateJourney(
  state: OnboardingJourneyState,
  patch: Partial<OnboardingJourneyState>,
): OnboardingJourneyState {
  const next = { ...state, ...patch };
  persistJourney(next);
  return next;
}

export function stepForJourneyStage(state: OnboardingJourneyState): WizardStep {
  const { stage, setup } = state;
  if (stage === 'demo') return 'demo';
  if (stage === 'handoff') return 'template';
  if (stage === 'setup')
    return setup?.step === 'config' && setup.template && setup.clients[setup.configIndex] ? 'config' : 'client';
  return 'done';
}

export function setupDraftForTemplate(
  state: OnboardingJourneyState,
  template: OnboardingTemplateDraft,
): OnboardingJourneyState {
  return updateJourney(state, {
    stage: 'setup',
    setup: {
      template,
      step: 'client',
      detectedClients: state.setup?.detectedClients ?? state.setup?.clients ?? [],
      clients: [],
      configs: {},
      configIndex: 0,
    },
  });
}
