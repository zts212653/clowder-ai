import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordCapabilityTipEvent } from '../capabilityTipEvents';
import { recordFeatureDemoStage, recordThreadProposalDemoUse } from '../feature-demo-telemetry';

vi.mock('../capabilityTipEvents', () => ({ recordCapabilityTipEvent: vi.fn(() => true) }));
const view = () => ({
  demoId: 'conversation-proposals-v1',
  tipId: 'capability-propose-thread',
  context: 'thinking' as const,
  surface: 'pending_bubble' as const,
});
beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
});
describe('demo observations, never treating a try click as use', () => {
  it('records each stage once per opportunity, and consumes completion only on a successful F128 creation', () => {
    const session = view();
    recordFeatureDemoStage(session, 'opened');
    recordFeatureDemoStage(session, 'opened');
    recordFeatureDemoStage(session, 'tried');
    expect(recordThreadProposalDemoUse({ threadId: 'created-before-completion' })).toBe(false);
    recordFeatureDemoStage(session, 'completed');
    expect(recordThreadProposalDemoUse({ error: 'not created' })).toBe(false);
    expect(recordThreadProposalDemoUse({ threadId: 'old-thread', deduped: true })).toBe(false);
    expect(recordThreadProposalDemoUse({ threadId: 'actual-created-thread' })).toBe(true);
    expect(recordThreadProposalDemoUse({ threadId: 'another-thread' })).toBe(false);
    expect(vi.mocked(recordCapabilityTipEvent).mock.calls.map(([event]) => event.event)).toEqual([
      'capability_tip_demo_opened',
      'capability_tip_demo_tried',
      'capability_tip_demo_completed',
      'capability_tip_demo_used',
    ]);
    expect(JSON.stringify(vi.mocked(recordCapabilityTipEvent).mock.calls)).not.toContain('actual-created-thread');
  });
  it('keeps the F128 completion when another film without a use signal is watched afterwards', () => {
    recordFeatureDemoStage(view(), 'completed');
    recordFeatureDemoStage(
      {
        demoId: 'steer-v1',
        tipId: 'feature-author-message-disposition',
        context: 'thinking',
        surface: 'pending_bubble',
      },
      'completed',
    );
    expect(recordThreadProposalDemoUse({ threadId: 'created-after-both' })).toBe(true);
  });
  it('does not count a successful approval outside the seven-day observation window', () => {
    vi.useFakeTimers();
    recordFeatureDemoStage(view(), 'completed');
    vi.advanceTimersByTime(7 * 86400000 + 1);
    expect(recordThreadProposalDemoUse({ threadId: 'created-too-late' })).toBe(false);
    vi.useRealTimers();
  });
});
