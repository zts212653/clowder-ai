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
    useGuideStore.setState({ session: null, completedGuides: new Set<string>(), pendingStart: null });
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

  // #877: exitGuide must record the dismissed guide into completedGuides so the
  // ChatContainer trigger guard blocks the same guide from re-firing on the next
  // keystroke (otherwise the overlay re-appears in an infinite loop).
  describe('exitGuide records completedGuides (re-trigger guard)', () => {
    it('adds `threadId::flowId` to completedGuides on exit', () => {
      useGuideStore.getState().startGuide(MOCK_FLOW, 'thread-1');
      useGuideStore.getState().exitGuide();
      const { session, completedGuides } = useGuideStore.getState();
      expect(session).toBeNull();
      expect(completedGuides.has('thread-1::test-flow')).toBe(true);
    });

    it('control_exit server event records the completion key for the matching session', () => {
      useGuideStore.getState().startGuide(MOCK_FLOW, 'thread-1');
      useGuideStore.getState().reduceServerEvent({
        action: 'control_exit',
        guideId: 'test-flow',
        threadId: 'thread-1',
      });
      const { session, completedGuides } = useGuideStore.getState();
      expect(session).toBeNull();
      expect(completedGuides.has('thread-1::test-flow')).toBe(true);
    });

    it('preserves previously completed keys when exiting another guide', () => {
      useGuideStore.setState({ completedGuides: new Set(['thread-0::other-flow']) });
      useGuideStore.getState().startGuide(MOCK_FLOW, 'thread-1');
      useGuideStore.getState().exitGuide();
      const { completedGuides } = useGuideStore.getState();
      expect(completedGuides.has('thread-0::other-flow')).toBe(true);
      expect(completedGuides.has('thread-1::test-flow')).toBe(true);
    });

    it('does not record a key when the session has no threadId', () => {
      useGuideStore.getState().startGuide(MOCK_FLOW); // threadId defaults to null
      useGuideStore.getState().exitGuide();
      const { session, completedGuides } = useGuideStore.getState();
      expect(session).toBeNull();
      expect(completedGuides.size).toBe(0);
    });

    it('is a safe no-op on completedGuides when there is no active session', () => {
      useGuideStore.getState().exitGuide();
      expect(useGuideStore.getState().session).toBeNull();
      expect(useGuideStore.getState().completedGuides.size).toBe(0);
    });

    // P1 fix (cloud Codex review on PR #2166): when completionFailed=true,
    // useGuideEngine has already called rollbackCompletedGuide to allow the user
    // to retry the failed completion. exitGuide must NOT re-add the key here, or
    // it would undo the rollback and block ChatContainer's retry trigger.
    it('does NOT record a completion key when completionFailed=true (preserves rollback for retry)', () => {
      // Simulate: guide reached complete phase (advanceStep added key) → /complete
      // API failed → useGuideEngine called markCompletionFailed + rollbackCompletedGuide
      // (which already removed the key). Now state: session present, completionFailed=true,
      // completedGuides does NOT contain the key.
      useGuideStore.getState().startGuide(MOCK_FLOW, 'thread-1');
      const sessionId = useGuideStore.getState().session?.sessionId ?? '';
      // Move to complete phase manually (mirror advanceStep behavior at last step) —
      // markCompletionFailed only flips the flag when phase is 'complete'
      useGuideStore.setState((s) =>
        s.session ? { session: { ...s.session, currentStepIndex: 3, phase: 'complete' } } : s,
      );
      useGuideStore.getState().markCompletionFailed(sessionId);
      // Verify pre-condition: completionFailed=true and key not in completedGuides
      expect(useGuideStore.getState().completionFailed).toBe(true);
      expect(useGuideStore.getState().completedGuides.has('thread-1::test-flow')).toBe(false);

      // Act: user clicks dismiss on failure overlay (handleDismiss = dismissWithReconciliation
      // when completionFailed=true; dismissWithReconciliation calls exitGuide)
      useGuideStore.getState().exitGuide();

      // Assert: session cleared, completionFailed reset, key NOT re-added (rollback preserved)
      const { session, completedGuides, completionFailed } = useGuideStore.getState();
      expect(session).toBeNull();
      expect(completionFailed).toBe(false);
      expect(completedGuides.has('thread-1::test-flow')).toBe(false);
    });

    // R2 P1 fix (cloud Codex on PR #2166 HEAD 39b128bd): exitGuide must
    // distinguish explicit dismiss/control-exit callers from defensive cleanup
    // callers (useGuideEngine thread-switch, GuideErrorBoundary auto-recovery).
    // Default keeps PR #877 behavior (record key); recordCompletion:false opts out.
    it('does NOT record a completion key when called with { recordCompletion: false } (thread-switch / error-boundary path)', () => {
      useGuideStore.getState().startGuide(MOCK_FLOW, 'thread-1');
      useGuideStore.getState().exitGuide({ recordCompletion: false });
      const { session, completedGuides } = useGuideStore.getState();
      expect(session).toBeNull();
      expect(completedGuides.has('thread-1::test-flow')).toBe(false);
    });

    it('preserves previously completed keys when called with { recordCompletion: false }', () => {
      useGuideStore.setState({ completedGuides: new Set(['thread-0::other-flow']) });
      useGuideStore.getState().startGuide(MOCK_FLOW, 'thread-1');
      useGuideStore.getState().exitGuide({ recordCompletion: false });
      const { completedGuides } = useGuideStore.getState();
      expect(completedGuides.has('thread-0::other-flow')).toBe(true);
      expect(completedGuides.has('thread-1::test-flow')).toBe(false);
    });

    it('does NOT clobber an unrelated completion key when completionFailed=true', () => {
      // Sanity: failure-dismiss on guide A must not affect previously-completed guide B.
      useGuideStore.setState({ completedGuides: new Set(['thread-0::other-flow']) });
      useGuideStore.getState().startGuide(MOCK_FLOW, 'thread-1');
      const sessionId = useGuideStore.getState().session?.sessionId ?? '';
      useGuideStore.setState((s) =>
        s.session ? { session: { ...s.session, currentStepIndex: 3, phase: 'complete' } } : s,
      );
      useGuideStore.getState().markCompletionFailed(sessionId);
      useGuideStore.getState().exitGuide();

      const { completedGuides } = useGuideStore.getState();
      expect(completedGuides.has('thread-0::other-flow')).toBe(true);
      expect(completedGuides.has('thread-1::test-flow')).toBe(false);
    });
  });
});
