import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type EvolutionAttributionExplanation, EvolutionAttributionPanel } from '../EvolutionAttributionPanel';

const explanation = (overrides: Partial<EvolutionAttributionExplanation> = {}): EvolutionAttributionExplanation => ({
  schemaVersion: 1,
  verdict: 'unresolved',
  headline: '证据还不能确诊是哪一层出的问题。',
  evidence: [
    {
      label: '本轮度量结果',
      ownerFeatureId: 'F267',
      ownerStateRef: 'measurement-result:evolve-video-skill:w7',
      identity: 'id:result',
    },
    {
      label: '冻结 cohort',
      ownerFeatureId: 'F267',
      ownerStateRef: 'frozen-cohort:evolve-video-skill:w7',
      identity: 'id:cohort',
    },
  ],
  competingAttributions: [
    { layer: 'execution', label: '执行层：被进化的对象自己（技能、提示、代码）', discriminating: true },
    { layer: 'observation', label: '眼睛层：打点缺失或信号不新鲜', discriminating: true },
  ],
  notAssessedLayers: [{ layer: 'rubric', label: '尺子层：评判口径本身（这一轮没有证据，只是没看，不等于已排除）' }],
  confidence: {
    basis: 'interval',
    label: '有区间估计：这次结论带着可复核的置信区间。',
    ownerStateRef: 'uncertainty-evidence:evolve-video-skill:w7',
  },
  comparability: { status: 'comparable', label: '尺子没换版，前后可以直接比。' },
  whyNotChange: ['归因还没确诊（多层并列或证据无法区分），现在改就是碰运气。'],
  gate: {
    status: 'blocked',
    blockers: [
      { code: 'attribution_not_actionable', label: '归因还没确诊，现在改就是碰运气。', ownerFeatureId: 'F311' },
    ],
  },
  ...overrides,
});

describe('F311 Phase 3 attribution panel', () => {
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
  });

  const render = (node: React.ReactNode) => {
    act(() => root.render(node));
    return container;
  };

  it('explains the verdict, evidence, competing attributions and confidence in plain language', () => {
    const view = render(<EvolutionAttributionPanel explanation={explanation()} />);
    const text = view.textContent ?? '';
    expect(view.querySelector('[data-testid="evolution-attribution-panel"]')).not.toBeNull();
    expect(text).toContain('证据还不能确诊是哪一层出的问题。');
    expect(text).toContain('本轮度量结果');
    expect(text).toContain('执行层');
    expect(text).toContain('眼睛层');
    expect(text).toContain('有区间估计');
    expect(text).toContain('尺子没换版，前后可以直接比。');
  });

  it('shows why nothing is changing and which gate blockers are open', () => {
    const view = render(<EvolutionAttributionPanel explanation={explanation()} />);
    const why = view.querySelector('[data-testid="evolution-why-not-change"]');
    expect(why?.textContent).toContain('现在改就是碰运气');
    expect(view.querySelector('[data-blocker-code="attribution_not_actionable"]')).not.toBeNull();
  });

  it('marks unlooked layers as not assessed rather than ruled out', () => {
    const view = render(<EvolutionAttributionPanel explanation={explanation()} />);
    const notAssessed = view.querySelector('[data-testid="evolution-not-assessed"]');
    expect(notAssessed?.textContent).toContain('只是没看，不等于已排除');
  });

  it('says the confidence bound is unknown instead of implying certainty', () => {
    const view = render(
      <EvolutionAttributionPanel
        explanation={explanation({
          confidence: { basis: 'unknown', label: '这一轮没有区间或判定力证据，置信边界未知。' },
        })}
      />,
    );
    expect(view.textContent).toContain('置信边界未知');
  });

  it('announces that Change Review is open when the gate is ready', () => {
    const view = render(
      <EvolutionAttributionPanel
        explanation={explanation({
          verdict: 'attributed',
          headline: '已经能指认问题出在哪一层了。',
          primaryLayer: { layer: 'execution', label: '执行层：被进化的对象自己（技能、提示、代码）' },
          whyNotChange: [],
          gate: { status: 'ready', blockers: [] },
        })}
      />,
    );
    const text = view.textContent ?? '';
    expect(text).toContain('已经能指认问题出在哪一层了。');
    expect(text).toContain('可以进入 Change Review');
    expect(view.querySelector('[data-testid="evolution-why-not-change"]')).toBeNull();
  });

  it('says the gate is not evaluated yet instead of implying it is open', () => {
    const view = render(
      <EvolutionAttributionPanel
        explanation={explanation({ whyNotChange: ['干预门尚未评估。'], gate: { status: 'pending', blockers: [] } })}
      />,
    );
    const text = view.textContent ?? '';
    expect(text).toContain('干预门尚未评估');
    expect(text).not.toContain('可以进入 Change Review');
  });

  it('shows two rubric versions as two distinct pieces of evidence', () => {
    const view = render(
      <EvolutionAttributionPanel
        explanation={explanation({
          evidence: [
            {
              label: '尺子版本',
              ownerFeatureId: 'F192',
              ownerStateRef: 'rubric:evolve',
              version: 'v3',
              assetKind: 'rubric',
              assetId: 'evolve',
              identity: 'id:rubric-v3',
            },
            {
              label: '尺子版本',
              ownerFeatureId: 'F192',
              ownerStateRef: 'rubric:evolve',
              version: 'v4',
              assetKind: 'rubric',
              assetId: 'evolve',
              identity: 'id:rubric-v4',
            },
          ],
        })}
      />,
    );
    const text = view.textContent ?? '';
    expect(text).toContain('v3');
    expect(text).toContain('v4');
  });

  it('stays honest when this cycle has no evaluation yet', () => {
    const view = render(<EvolutionAttributionPanel explanation={null} />);
    expect(view.textContent).toContain('这一轮还没有评估结果');
  });
});
