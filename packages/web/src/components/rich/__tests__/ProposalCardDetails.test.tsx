import { createCatId } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { writeShellLanguage } from '../../shell/shell-language';

vi.mock('@/hooks/useThreadDisplayInfo', () => ({
  useThreadDisplayInfo: () => ({ currentThread: { title: '返回原处的对话' } }),
}));
vi.mock('../ApprovalMember', () => ({ ApprovalMember: () => <span>狸花猫</span> }));

import { ProposalCardDetails } from '../ProposalCardDetails';

// The legacy disclosure is a component contract. The v2 journey observes its own inline summary.
it('keeps the original reason and exact development contract in the read-only disclosure', async () => {
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  writeShellLanguage('zh');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const scope = {
    featureRef: 'feature:F322',
    phaseKey: 'S3',
    workUnitRef: 'feature-phase:F322:S3',
    acceptedSourceRef: 'file:docs/features/F322-everyday-work-experience.md',
    acceptedRevision: 'a'.repeat(40),
  };
  try {
    await act(async () =>
      root.render(
        <ProposalCardDetails
          workMode="parallel"
          reportingMode="none"
          proposal={{
            reason: '先核对原始记录，再决定下一步。\n这是提议里的原话。',
            parentThreadId: 'thread-return',
            projectPath: '/work/fixture',
            preferredCats: [createCatId('glm52')],
            initialMessage: '请核对证据',
            subjectTaskTitle: '隔离审批验证',
            subjectTaskId: 'task:work:isolated-approval',
            approvedDevelopmentScope: scope,
          }}
        />,
      ),
    );
    const reason = host.querySelector<HTMLDetailsElement>('[data-testid="proposal-reason"]')!;
    expect(reason.open).toBe(false);
    reason.open = true;
    expect(reason.querySelector('[role="region"]')?.textContent).toContain('这是提议里的原话。');
    expect(host.textContent).toMatch(/谁来做:[\s\S]*狸花猫/);
    expect(host.textContent).toMatch(/放在:[\s\S]*返回原处的对话/);
    expect(host.textContent).toContain('并行 · 不回报');
    const technical = [...host.querySelectorAll<HTMLDetailsElement>('details')].find(
      (node) => node.querySelector('summary')?.textContent === '技术详情',
    )!;
    expect(technical.open).toBe(false);
    technical.open = true;
    expect(technical.textContent).toContain('隔离审批验证');
    expect(JSON.parse(technical.querySelector('pre')!.textContent!)).toEqual({
      subjectTaskId: 'task:work:isolated-approval',
      scope,
    });
    expect(host.querySelector('button')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
    environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
