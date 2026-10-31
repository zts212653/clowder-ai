import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HubEvalLifecycleSummary } from '../HubEvalLifecycleSummary';

describe('F266 stable case lifecycle summary', () => {
  it('shows a recoverable responsibility routing blocker without inventing a task or lease', () => {
    const html = renderToStaticMarkup(
      <HubEvalLifecycleSummary
        lifecycle={{
          availability: 'available',
          ownerResponseStatus: 'not_started',
          closureStatus: 'open',
          stale: false,
          targetOwnerCatId: 'opus-47',
          repairDebtStatus: 'active',
          reevalDebtStatus: 'not_scheduled',
          reevalStatus: 'not_requested',
          responsibilityBlocker: {
            eventId: 'responsibility-blocked-f203',
            reasonCode: 'feature_thread_not_found',
            featureId: 'F203',
            ownerCatId: 'opus-47',
            candidateThreadIds: [],
          },
        }}
      />,
    );

    expect(html).toContain('责任路由待恢复');
    expect(html).toContain('F203');
    expect(html).toContain('尚未找到唯一归属 thread');
    expect(html).not.toContain('责任任务');
    expect(html).not.toContain('责任租约');
  });

  it('shows durable responsibility and separate main/live facts', () => {
    const html = renderToStaticMarkup(
      <HubEvalLifecycleSummary
        lifecycle={{
          availability: 'available',
          ownerResponseStatus: 'acknowledged',
          closureStatus: 'live_active',
          stale: false,
          caseId: `eval-case-v1-${'a'.repeat(64)}`,
          activeVerdictId: 'capability-wakeup-2026-08-01-rich-messaging',
          observedVerdictIds: [
            'capability-wakeup-2026-08-01-rich-messaging',
            'capability-wakeup-2026-08-08-rich-messaging',
          ],
          targetOwnerCatId: 'codex-sol',
          lifecycleOwnerCatId: 'codex-sol',
          taskId: 'task-case-cycle',
          leaseId: 'lease-case-cycle',
          leaseGeneration: 2,
          mainCommitSha: 'b'.repeat(40),
          liveCommitSha: 'b'.repeat(40),
          reevalStatus: 'not_requested',
          actionRefs: [
            {
              kind: 'other',
              availability: 'available',
              value: 'https://example.com/f273/lifecycle',
            },
          ],
        }}
      />,
    );

    expect(html).toContain('运行环境已生效');
    expect(html).toContain('task-case-cycle');
    expect(html).toContain('lease-case-cycle · generation 2');
    expect(html).toContain(`main · ${'b'.repeat(40)}`);
    expect(html).toContain(`live · ${'b'.repeat(40)}`);
    expect(html).toContain('2 个周期');
    expect(html).toContain('href="https://example.com/f273/lifecycle"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('shows why executable custody is blocked while preserving task and lease truth', () => {
    const html = renderToStaticMarkup(
      <HubEvalLifecycleSummary
        lifecycle={{
          availability: 'available',
          ownerResponseStatus: 'acknowledged',
          closureStatus: 'live_active',
          stale: true,
          reevalDebtStatus: 'due',
          reevalStatus: 'not_requested',
          custodyDispatchBlocker: {
            eventId: 'custody-dispatch-blocked',
            stage: 'reevaluation',
            reasonCode: 'carrier_not_enqueued',
            taskId: 'task-reeval-cycle',
            leaseId: 'lease-reeval-cycle',
            leaseGeneration: 2,
            carrierMessageId: 'message-reeval-blocked',
          },
        }}
      />,
    );

    expect(html).toContain('执行载体待恢复');
    expect(html).toContain('复评任务已经建立并持有有效租约');
    expect(html).toContain('执行载体已经持久化，但尚未被队列接受');
    expect(html).toContain('task-reeval-cycle');
    expect(html).toContain('lease-reeval-cycle · generation 2');
  });
});
