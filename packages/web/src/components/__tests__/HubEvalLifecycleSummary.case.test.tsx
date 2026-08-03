import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HubEvalLifecycleSummary } from '../HubEvalLifecycleSummary';

describe('F266 stable case lifecycle summary', () => {
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
        }}
      />,
    );

    expect(html).toContain('运行环境已生效');
    expect(html).toContain('task-case-cycle');
    expect(html).toContain('lease-case-cycle · generation 2');
    expect(html).toContain(`main · ${'b'.repeat(40)}`);
    expect(html).toContain(`live · ${'b'.repeat(40)}`);
    expect(html).toContain('2 个周期');
  });
});
