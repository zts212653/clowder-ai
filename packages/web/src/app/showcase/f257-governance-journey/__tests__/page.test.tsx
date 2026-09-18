import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import F257GovernanceJourneyDemo from '../page';

describe('F257 governance journey experience gate', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render() {
    await act(async () => root.render(<F257GovernanceJourneyDemo />));
  }

  async function click(testId: string) {
    await act(async () => {
      const target = container.querySelector(`[data-testid="${testId}"]`);
      const button = target instanceof HTMLButtonElement ? target : target?.querySelector('button');
      if (!(button instanceof HTMLButtonElement)) throw new Error(`missing button ${testId}`);
      button.click();
    });
  }

  async function type(testId: string, value: string) {
    await act(async () => {
      const target = container.querySelector(`[data-testid="${testId}"]`);
      if (!(target instanceof HTMLTextAreaElement)) throw new Error(`missing textarea ${testId}`);
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      valueSetter?.call(target, value);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('shows the five-step human journey with no experiment, interruption, or engineering event names', async () => {
    await render();
    const controls = container.querySelector('[aria-label="旅程场景"]');
    expect(controls?.textContent).toContain('收集证据');
    expect(controls?.textContent).toContain('评估出结论');
    expect(controls?.textContent).toContain('系统建议干预');
    expect(controls?.textContent).toContain('你审批');
    expect(controls?.textContent).toContain('回到下一轮');
    expect(container.querySelector('[data-testid="f257-journey-truth-label"]')?.textContent).toContain('演示数据');
    expect(container.textContent).not.toMatch(
      /TraceAnnotationCommitted|ObjectiveJudgmentCommitted|GovernanceCandidateOpened|OverrideExecutionInterrupted|PatchTrial|启动试验|继续执行/,
    );
  });

  it('keeps the explicit content, window, data, metric, and conclusion evidence chain', async () => {
    await render();
    await click('f257-journey-next');

    const evidence = container.querySelector('[data-testid="f257-journey-evaluation-evidence"]');
    expect(evidence?.textContent).toContain('S13@v1');
    expect(evidence?.textContent).toContain('snapshot-s13-schema-failure');
    expect(evidence?.textContent).toContain('2026-08-24T12:00:00.000Z');
    expect(evidence?.textContent).toContain('窗口已锁定');
    expect(evidence?.textContent).toContain('InjectionTrace summary');
    expect(evidence?.textContent).toContain('tool-schema-failure-count');
    expect(evidence?.textContent).toContain('counter-zero');
    expect(evidence?.textContent).toContain('count = 3');
    expect(evidence?.textContent).toContain('retire-candidate');
  });

  it('shows automatic governance and lets apply create a visible v2 unit', async () => {
    await render();
    await click('f257-journey-next');
    await click('f257-journey-next');

    expect(container.querySelector('[data-testid="f257-journey-approval-card"]')).not.toBeNull();
    expect(container.textContent).toContain('系统自动创建');
    expect(container.textContent).toContain('用户无需触发 governance');
    expect(container.textContent).toContain('修改内容后生成 v2');
    await click('f257-journey-apply');
    expect(container.textContent).toContain('你批准了内容修改');
    expect(container.textContent).toContain('setContentOverride');
    expect(container.textContent).toContain('审批接线待补');

    await click('f257-journey-next');
    expect(container.querySelector('[data-testid="f257-version-unit-model"]')?.textContent).toContain('v1 → v2');
    expect(container.textContent).toContain('v2');
    expect(container.textContent).toContain('新版本从 tracing 开始');

    const lifeline = container.querySelector('[data-testid="f257-journey-round-lifeline"]');
    expect(lifeline?.querySelectorAll('[data-testid^="f257-lifeline-version-"]')).toHaveLength(2);
    expect(lifeline?.querySelectorAll('[data-testid="f257-lifeline-version-1"]')).toHaveLength(1);
    expect(lifeline?.querySelector('[data-testid="f257-lifeline-round-1-1"]')?.textContent).toContain('approved');
    expect(lifeline?.querySelector('[data-testid="f257-lifeline-round-2-1"]')?.textContent).toContain('当前');
  });

  it('keeps reject in v1 and starts a second round with the reason preserved', async () => {
    await render();
    await click('f257-journey-next');
    await click('f257-journey-next');
    await click('f257-journey-reject');
    await type('f257-journey-reject-reason', '本轮先不改内容；继续收集反例后再评估。');
    await click('f257-journey-confirm-reject');

    expect(container.textContent).toContain('你拒绝了本次修改');
    expect(container.textContent).toContain('不生成新版本');
    expect(container.textContent).toContain('本轮先不改内容');

    await click('f257-journey-next');
    const unit = container.querySelector('[data-testid="f257-version-unit-model"]');
    expect(unit?.textContent).toContain('仍在 v1');
    expect(unit?.textContent).toContain('第 2 轮');
    expect(container.textContent).toContain('Candidate.approval.note');
    expect(container.textContent).toContain('需要后端触点');
    expect(container.textContent).not.toContain('v2');

    const lifeline = container.querySelector('[data-testid="f257-journey-round-lifeline"]');
    expect(lifeline?.querySelectorAll('[data-testid^="f257-lifeline-version-"]')).toHaveLength(1);
    expect(lifeline?.querySelectorAll('[data-testid="f257-lifeline-version-1"]')).toHaveLength(1);
    expect(lifeline?.querySelectorAll('[data-version="1"][data-round]')).toHaveLength(2);
    expect(lifeline?.querySelector('[data-testid="f257-lifeline-round-1-1"]')?.textContent).toContain('rejected');
    expect(lifeline?.querySelector('[data-testid="f257-lifeline-round-1-1"]')?.textContent).toContain('governance');
    expect(lifeline?.querySelector('[data-testid="f257-lifeline-round-1-2"]')?.textContent).toContain('当前');
    expect(lifeline?.textContent).not.toContain('第 1 轮');
    expect(lifeline?.textContent).not.toContain('第 2 轮');
  });
});
