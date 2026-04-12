import { beforeEach, describe, expect, it } from 'vitest';
import type { OrchestrationFlow, OrchestrationStep } from '../guideStore';
import { useGuideStore } from '../guideStore';

const MOCK_STEPS: OrchestrationStep[] = [
  { id: 's1', target: 'hub.trigger', tips: 'Click here', advance: 'click' },
  { id: 's2', target: 'cats.overview', tips: 'Navigate here', advance: 'click' },
  { id: 's3', target: 'cats.add-member', tips: 'Add a member', advance: 'click', timeoutSec: 30 },
];

const MOCK_FLOW: OrchestrationFlow = {
  id: 'test-flow',
  name: 'Test Flow',
  description: 'A test flow',
  steps: MOCK_STEPS,
};

describe('guideStore', () => {
  beforeEach(() => {
    useGuideStore.setState({ session: null });
  });

  it('starts a guide session with correct initial state', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    const s = useGuideStore.getState().session!;
    expect(s).not.toBeNull();
    expect(s.flow.id).toBe('test-flow');
    expect(s.currentStepIndex).toBe(0);
    expect(s.phase).toBe('locating');
    expect(s.flow.steps).toHaveLength(3);
    expect(s.startedAt).toBeGreaterThan(0);
  });

  it('advanceStep moves to next step and resets phase to locating', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    useGuideStore.getState().advanceStep();
    const s = useGuideStore.getState().session!;
    expect(s.currentStepIndex).toBe(1);
    expect(s.phase).toBe('locating');
  });

  it('marks flow complete when advancing past last step', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    useGuideStore.getState().advanceStep(); // -> 1
    useGuideStore.getState().advanceStep(); // -> 2
    useGuideStore.getState().advanceStep(); // -> 3 (past end)
    const s = useGuideStore.getState().session!;
    expect(s.currentStepIndex).toBe(3);
    expect(s.phase).toBe('complete');
  });

  it('exitGuide clears session', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    useGuideStore.getState().exitGuide();
    expect(useGuideStore.getState().session).toBeNull();
  });

  it('setPhase updates phase', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    useGuideStore.getState().setPhase('active');
    expect(useGuideStore.getState().session!.phase).toBe('active');
  });

  it('setPhase is no-op when session is null', () => {
    useGuideStore.getState().setPhase('active');
    expect(useGuideStore.getState().session).toBeNull();
  });

  it('setPhase is no-op when phase is already the same', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    // phase starts as 'locating'
    useGuideStore.getState().setPhase('locating');
    expect(useGuideStore.getState().session!.phase).toBe('locating');
  });

  it('advanceStep is no-op when session is null', () => {
    useGuideStore.getState().advanceStep();
    expect(useGuideStore.getState().session).toBeNull();
  });

  it('preserves timeoutSec on steps via flow', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    const s = useGuideStore.getState().session!;
    expect(s.flow.steps[0].timeoutSec).toBeUndefined();
    expect(s.flow.steps[2].timeoutSec).toBe(30);
  });

  it('generates unique session IDs', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    const id1 = useGuideStore.getState().session!.sessionId;
    useGuideStore.getState().startGuide(MOCK_FLOW);
    const id2 = useGuideStore.getState().session!.sessionId;
    expect(id1).not.toBe(id2);
  });

  it('stores the full flow object in session', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    const s = useGuideStore.getState().session!;
    expect(s.flow).toEqual(MOCK_FLOW);
    expect(s.flow.name).toBe('Test Flow');
    expect(s.flow.description).toBe('A test flow');
  });
});
