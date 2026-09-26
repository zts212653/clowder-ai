import { describe, expect, it } from 'vitest';
import {
  buildRealMembers,
  canCommitFirstRealMessage,
  canContinueClientSetup,
  createJourneyState,
  firstRealMessageSyncAction,
  markFirstRealMessage,
  mergeDetectedAuthStatus,
  type OnboardingClient,
  restoreFirstRealMessagePendingMarker,
  restoreJourneyState,
  stableOnboardingMemberId,
} from '../onboarding-journey';

const readyClaude: OnboardingClient = {
  client: 'claude',
  label: 'Claude',
  installed: true,
  authStatus: 'ready',
};

describe('onboarding journey state', () => {
  it('starts with the three-cat demo and no real members', () => {
    const state = createJourneyState();
    expect(state.stage).toBe('demo');
    expect(state.demoParticipants).toHaveLength(3);
    expect(state.realMembers).toEqual([]);
    expect(state.completedAt).toBeUndefined();
    expect(state.demoScene).toBe('opening');
    expect(state.demoPaused).toBe(false);
  });

  it('derives a stable member id for retries of the same journey', () => {
    const first = stableOnboardingMemberId('journey-1234', 'planner', 'codex');
    expect(stableOnboardingMemberId('journey-1234', 'planner', 'codex')).toBe(first);
    expect(stableOnboardingMemberId('journey-1234', 'planner', 'claude')).not.toBe(first);
  });

  it('restores demo scene and pause gate', () => {
    const state = createJourneyState();
    state.demoScene = 'review';
    state.demoPaused = true;
    const restored = restoreJourneyState(JSON.stringify(state));
    expect(restored?.demoScene).toBe('review');
    expect(restored?.demoPaused).toBe(true);
  });

  it('blocks setup when there are no clients or a client is not authenticated', () => {
    expect(canContinueClientSetup([])).toBe(false);
    expect(canContinueClientSetup([{ ...readyClaude, authStatus: 'login_required' }])).toBe(false);
    expect(canContinueClientSetup([readyClaude])).toBe(true);
  });

  it('keeps a local login pending marker until detection proves ready', () => {
    expect(mergeDetectedAuthStatus('login_required', 'pending')).toBe('pending');
    expect(mergeDetectedAuthStatus('pending', 'pending')).toBe('pending');
    expect(mergeDetectedAuthStatus('ready', 'pending')).toBe('ready');
    expect(mergeDetectedAuthStatus('login_required', 'login_required')).toBe('login_required');
  });

  it('projects only selected ready clients into real members', () => {
    const members = buildRealMembers([
      readyClaude,
      { client: 'codex', label: 'Codex', installed: true, authStatus: 'login_required' },
      { client: 'gemini', label: 'Gemini', installed: true, authStatus: 'ready' },
    ]);
    expect(members.map((member) => member.client)).toEqual(['claude', 'gemini']);
    expect(members.every((member) => member.isReal)).toBe(true);
  });

  it('restores unfinished state without replaying the demo', () => {
    const state = createJourneyState();
    state.stage = 'handoff';
    state.demoCompletedAt = 123;
    state.realMembers = [{ client: 'claude', label: 'Claude', isReal: true }];
    const restored = restoreJourneyState(JSON.stringify(state));
    expect(restored?.stage).toBe('handoff');
    expect(restored?.demoCompletedAt).toBe(123);
  });

  it('marks completion only after the first real user message', () => {
    const state = createJourneyState();
    state.stage = 'ready';
    const completed = markFirstRealMessage(state, 456);
    expect(completed.stage).toBe('complete');
    expect(completed.completedAt).toBe(456);
    expect(markFirstRealMessage(completed, 789)).toEqual(completed);
  });

  it('does not commit while hydration is missing or the server PATCH did not confirm completion', () => {
    const state = createJourneyState();
    state.stage = 'ready';
    expect(canCommitFirstRealMessage(state, undefined, undefined)).toBe(false);
    expect(canCommitFirstRealMessage(state, { journeyId: state.journeyId }, { journeyId: state.journeyId })).toBe(
      false,
    );
    expect(
      canCommitFirstRealMessage(
        state,
        { journeyId: state.journeyId },
        { journeyId: state.journeyId, completedAt: 456 },
      ),
    ).toBe(true);
  });

  it('records the first message before hydration and retries after the matching thread arrives', () => {
    const state = createJourneyState();
    state.stage = 'ready';
    expect(firstRealMessageSyncAction(state, undefined)).toBe('wait-for-hydration');
    expect(firstRealMessageSyncAction(state, { journeyId: 'other-journey' })).toBe('ignore');
    expect(firstRealMessageSyncAction(state, { journeyId: state.journeyId })).toBe('patch');
    expect(firstRealMessageSyncAction(state, { journeyId: state.journeyId, completedAt: 789 })).toBe(
      'already-complete',
    );
  });

  it('keeps a failed PATCH retryable instead of completing locally', () => {
    const state = createJourneyState();
    state.stage = 'ready';
    const actionBeforeRetry = firstRealMessageSyncAction(state, { journeyId: state.journeyId });
    expect(actionBeforeRetry).toBe('patch');
    expect(state.completedAt).toBeUndefined();
    expect(firstRealMessageSyncAction(state, { journeyId: state.journeyId })).toBe('patch');
  });

  it('restores a pending first-message marker after refresh and rejects malformed markers', () => {
    expect(
      restoreFirstRealMessagePendingMarker(JSON.stringify({ journeyId: 'journey-1234', threadId: 'thread-1' })),
    ).toEqual({ journeyId: 'journey-1234', threadId: 'thread-1' });
    expect(restoreFirstRealMessagePendingMarker('{')).toBeNull();
    expect(
      restoreFirstRealMessagePendingMarker(JSON.stringify({ journeyId: 'short', threadId: 'thread-1' })),
    ).toBeNull();
  });
});
