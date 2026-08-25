import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalDecisionCard } from '../ApprovalDecisionCard';

describe('F305 ApprovalDecisionCard presentation contract', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders one decision hierarchy and keeps supporting details folded', async () => {
    await act(async () => {
      root.render(
        React.createElement(ApprovalDecisionCard, {
          testId: 'decision-card-fixture',
          header: React.createElement('span', null, '待我处理'),
          title: '确认会议整理内容',
          actionReason: React.createElement('p', null, '记录已经整理好，只需确认保存位置。'),
          recommendation: React.createElement('p', null, '建议保存到模型质量专项。'),
          currentDecision: React.createElement('button', { type: 'button' }, '确认并开始整理'),
          details: {
            label: '查看来源与记录',
            content: React.createElement('p', { 'data-testid': 'decision-detail-content' }, 'rev 1'),
          },
        }),
      );
    });

    expect(container.querySelector('[data-testid="decision-card-fixture"]')?.textContent).toContain('确认会议整理内容');
    expect(container.querySelector('[data-testid="approval-action-reason"]')?.textContent).toContain('只需确认');
    expect(container.querySelector('[data-testid="approval-recommendation"]')?.textContent).toContain('模型质量专项');
    expect(container.querySelector('[data-testid="approval-current-decision"]')?.textContent).toContain(
      '确认并开始整理',
    );
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(container.querySelector('[data-testid="decision-detail-content"]')).not.toBeNull();
  });

  it('gives long user-facing summaries a recoverable three-line disclosure', async () => {
    const longSummary = '模型质量周会需要整理成会议纪要、决策清单、Roadmap 和行动项，并保存到模型质量专项。';

    await act(async () => {
      root.render(
        React.createElement(ApprovalDecisionCard, {
          testId: 'long-summary-card',
          title: longSummary,
          currentDecision: React.createElement('button', { type: 'button' }, '确认并开始整理'),
        }),
      );
    });

    const measuredTitle = container.querySelector<HTMLElement>('h3[data-overflow-measure="block"]');
    expect(measuredTitle?.textContent).toBe(longSummary);
    expect(measuredTitle?.style.webkitLineClamp).toBe('3');
  });

  it('stays presentation-only and does not acquire approval business concepts', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/ApprovalDecisionCard.tsx'), 'utf8');
    const genericAdapter = readFileSync(resolve(process.cwd(), 'src/components/GenericApprovalItemCard.tsx'), 'utf8');
    const meetingAdapter = readFileSync(resolve(process.cwd(), 'src/components/MeetingIntakeCard.tsx'), 'utf8');
    const candidate = readFileSync(
      resolve(process.cwd(), 'src/app/dev/f305-approval-design-gate/candidate-card.tsx'),
      'utf8',
    );
    const demoContract = readFileSync(
      resolve(process.cwd(), '../../docs/discussions/2026-08-22-f305-ui-design-gate-closure/demo-contract.md'),
      'utf8',
    );
    const workspacePane = readFileSync(resolve(process.cwd(), 'src/components/ApprovalPendingPane.tsx'), 'utf8');
    const mobileDrawer = readFileSync(resolve(process.cwd(), 'src/components/ApprovalHubDrawer.tsx'), 'utf8');

    expect(source).not.toMatch(
      /useApprovalHubStore|ApprovalItem|sourceFeatureId|proposalId|revision|resolveEndpoint|\/api\//,
    );
    expect(genericAdapter).toMatch(/<ApprovalDecisionCard/);
    expect(meetingAdapter).toMatch(/<ApprovalDecisionCard/);
    expect(candidate).toMatch(/<ApprovalDecisionCard/);
    expect(candidate).not.toMatch(/MeetingIntake(?:Summary|Form|RepairActions)/);
    expect(demoContract).toContain('冻结为设计证据快照');
    expect(workspacePane).toMatch(/<ApprovalItemCard/);
    expect(mobileDrawer).toMatch(/<ApprovalItemCard/);
  });
});
