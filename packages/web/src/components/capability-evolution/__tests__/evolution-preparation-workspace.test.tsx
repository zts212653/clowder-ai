import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOMENTS } from '../EvolutionJourney';
import { parseProgramProjection } from '../evolution-program-projection';
import { DEFAULT_READING, useEvolutionReading } from '../evolution-reading-state';
import { EvolutionMomentContext } from '../journey/EvolutionMomentContext';
import { EvolutionPreparationWorkspace } from '../preparation/EvolutionPreparationWorkspace';
import { PROGRAM_ID, programFixture } from './evolution-fixtures';
import { evolutionPreparationFixture } from './evolution-preparation-fixtures';

vi.mock('@/utils/api-client', () => ({
  apiFetch: async () => new Response('{}', { status: 404 }),
}));

function fixtureProjection() {
  const parsed = parseProgramProjection({
    ...programFixture('instrumenting'),
    preparation: evolutionPreparationFixture(),
  });
  if (!parsed) throw new Error('fixture projection failed to parse');
  return parsed;
}

describe('F311 production preparation reading surface', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    useEvolutionReading.setState({ programs: {}, workspaceProgramIds: {} });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(projection = fixtureProjection()) {
    await act(async () => root.render(<EvolutionPreparationWorkspace projection={projection} />));
  }

  async function choose(label: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      node.textContent?.includes(label),
    );
    expect(button, label).toBeDefined();
    await act(async () => button?.click());
  }

  it('keeps work progress independent from the modifiability boundary', async () => {
    await render();
    const data = host.querySelector('[data-preparation-item="data"]');
    const environment = host.querySelector('[data-preparation-item="environment"]');
    const records = host.querySelector('[data-preparation-item="records"]');

    expect(data?.textContent).toContain('准备中');
    expect(data?.textContent).toContain('可改');
    expect(data?.textContent).toContain('codex-terra');
    expect(data?.querySelector('[data-preparation-spinner="true"]')).not.toBeNull();
    expect(environment?.textContent).toContain('已有提交');
    expect(environment?.textContent).toContain('未见条目级活动');
    expect(environment?.textContent).toContain('本轮不可改');
    expect(environment?.querySelector('[data-preparation-spinner="true"]')).toBeNull();
    expect(records?.textContent).toContain('已有提交');
    expect(records?.textContent).not.toContain('待接手');
    expect(records?.textContent).toContain('待核实');
    expect(records?.querySelector('[data-progress-state]')?.textContent).not.toContain('codex-terra');
    expect(host.textContent).toContain('当前 Program 只绑定一个 target');
    expect(host.textContent).toContain('候选地图不会改写此绑定');
  });

  it('gives every preparation category a semantic icon, durable label and distinct visual role', async () => {
    await render();
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')];

    expect(tabs).toHaveLength(4);
    expect(new Set(tabs.map((tab) => tab.dataset.preparationCategory))).toEqual(
      new Set(['object', 'rubric', 'measurement', 'diagnosis']),
    );
    expect(tabs.every((tab) => tab.querySelector('[data-preparation-section-icon] svg[aria-hidden="true"]'))).toBe(
      true,
    );
    expect(tabs.map((tab) => tab.querySelector('[data-preparation-category-hint]')?.textContent)).toEqual([
      '范围与可改边界',
      '判法、反例与裁判',
      'GT 来源与实验条件',
      '事实、未知与竞争解释',
    ]);
    expect(
      host.querySelector('[data-testid="evolution-preparation-workspace"]')?.getAttribute('data-active-section'),
    ).toBe('object_map');
  });

  it('lets every rubric disclose domain, judge, payer and jump to its GT source', async () => {
    await render();
    await choose('好坏规约');
    expect(host.querySelectorAll('[data-preparation-criterion]')).toHaveLength(6);
    const professional = host.querySelector('[data-preparation-criterion="professional-judgment"]');
    expect(professional?.textContent).toContain('需校准判断');
    expect(professional?.textContent).toContain('校准裁判');
    expect(professional?.textContent).toContain('付薪方');
    const source = professional?.querySelector<HTMLButtonElement>('[data-gt-source-jump="domain-precedents"]');
    expect(source).not.toBeNull();
    await act(async () => source?.click());

    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('测量与实验准备');
    const target = host.querySelector('[data-gt-source-key="domain-precedents"]');
    expect(target?.textContent).toContain('领域判断与边界判例');
    expect(target?.getAttribute('tabindex')).toBe('-1');
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.preparationGtSourceKey).toBe('domain-precedents');
    await choose('返回规约：专业判断');
    const returned = host.querySelector<HTMLDetailsElement>('[data-preparation-criterion="professional-judgment"]');
    expect(returned?.open).toBe(true);
    expect(document.activeElement).toBe(returned?.querySelector('summary'));
    await act(async () => root.render(null));
    await render();
    expect(host.querySelector<HTMLDetailsElement>('[data-preparation-criterion="professional-judgment"]')?.open).toBe(
      true,
    );
  });

  it('never turns collection into validity and keeps missing evidence visible', async () => {
    useEvolutionReading.getState().update(PROGRAM_ID, {
      ...DEFAULT_READING,
      preparationSection: 'measurement_plan',
    });
    await render();
    const facts = host.querySelector('[data-gt-source-key="business-facts"]');
    const outcomes = host.querySelector('[data-gt-source-key="real-outcomes"]');

    expect(facts?.textContent).toContain('已采集');
    expect(facts?.textContent).toContain('待核验');
    expect(facts?.textContent).toContain('失败回执可能缺失');
    expect(facts?.textContent).not.toContain('可用于明确范围');
    expect(outcomes?.textContent).toContain('采集中');
    expect(outcomes?.textContent).toContain('范围声明待核实');
    expect(outcomes?.querySelector('[data-validity-state="bounded"]')).toBeNull();
    expect(outcomes?.textContent).toContain('沉默不能判为满意');
  });

  it('shows the current stale draft, exact history and bounded source failures without borrowing old content', async () => {
    useEvolutionReading.getState().update(PROGRAM_ID, {
      ...DEFAULT_READING,
      preparationSection: 'baseline_diagnosis',
    });
    await render();
    expect(host.textContent).toContain('需更新');
    expect(host.textContent).toContain('依赖的准备稿已经变化');
    expect(host.textContent).toContain('当前只能形成初步诊断');
    expect(host.textContent).toContain('以前的提交');
    expect(host.textContent).toContain('旧稿');

    const value = evolutionPreparationFixture();
    const current = value.sections.baseline_diagnosis.current;
    if (!current) throw new Error('current baseline fixture missing');
    const unavailable = structuredClone(current);
    delete unavailable.submission;
    value.sections.baseline_diagnosis.current = {
      ...unavailable,
      status: 'source_unavailable',
    };
    const parsed = parseProgramProjection({ ...programFixture('instrumenting'), preparation: value });
    if (!parsed) throw new Error('source unavailable fixture failed to parse');
    await render(parsed);
    expect(host.textContent).toContain('来源已不可用');
    expect(host.querySelector('[data-current-source-status]')?.textContent).not.toContain('当前只能形成初步诊断');
    expect(host.textContent).toContain('以前的提交');
  });

  it('treats an event-before-message gap as recoverable interruption, not live work or a finished submission', async () => {
    useEvolutionReading.getState().update(PROGRAM_ID, {
      ...DEFAULT_READING,
      preparationSection: 'baseline_diagnosis',
    });
    const value = evolutionPreparationFixture();
    const current = value.sections.baseline_diagnosis.current;
    if (!current) throw new Error('current baseline fixture missing');
    const intent = structuredClone(current);
    delete intent.submission;
    value.sections.baseline_diagnosis.current = { ...intent, status: 'materializing' };
    const parsed = parseProgramProjection({ ...programFixture('instrumenting'), preparation: value });
    if (!parsed) throw new Error('materializing fixture failed to parse');
    await render(parsed);

    const currentCard = host.querySelector('[data-current-source-status="materializing"]');
    expect(currentCard?.textContent).toContain('提交意图已经登记');
    expect(currentCard?.textContent).toContain('同一命令重试恢复');
    expect(currentCard?.textContent).not.toContain('当前只能形成初步诊断');
    expect(currentCard?.querySelector('[data-preparation-spinner="true"]')).toBeNull();
  });

  it('does not invent a worker or spinner for empty records and stops animation for ended work', async () => {
    const value = evolutionPreparationFixture();
    for (const section of Object.values(value.sections)) {
      section.current = null;
      section.history = [];
      section.activities = [];
    }
    const parsed = parseProgramProjection({ ...programFixture('instrumenting'), preparation: value });
    if (!parsed) throw new Error('empty preparation fixture failed to parse');
    await render(parsed);
    expect(host.textContent).toContain('还没有提交');
    expect(host.textContent).toContain('待猫继续准备');
    expect(host.textContent).not.toContain('codex-terra');
    expect(host.querySelector('[data-preparation-spinner="true"]')).toBeNull();

    value.sections.object_map.activities = [
      {
        activityRef: { ownerFeatureId: 'F167', ownerStateRef: 'invocation:ended-work' },
        section: 'object_map',
        focus: '已经结束的调查',
        occurredAt: '2026-09-09T08:10:00.000Z',
        state: 'terminal',
        spinning: false,
        invocationId: 'ended-work',
        threadId: 'thread-preparation',
        catId: 'codex-terra',
      },
    ];
    const ended = parseProgramProjection({ ...programFixture('instrumenting'), preparation: value });
    if (!ended) throw new Error('ended activity fixture failed to parse');
    await render(ended);
    expect(host.textContent).toContain('运行已结束');
    expect(host.querySelector('[data-preparation-spinner="true"]')).toBeNull();

    const unknownValue = structuredClone(value);
    const unknownActivity = unknownValue.sections.object_map.activities[0];
    if (!unknownActivity) throw new Error('unknown activity fixture missing');
    unknownActivity.state = 'unknown';
    delete unknownActivity.catId;
    const unknown = parseProgramProjection({ ...programFixture('instrumenting'), preparation: unknownValue });
    if (!unknown) throw new Error('unknown activity fixture failed to parse');
    await render(unknown);
    expect(host.textContent).toContain('活动状态待核实');
    expect(host.querySelector('[data-preparation-spinner="true"]')).toBeNull();
  });

  it('persists only reading coordinates across an unmount, never owner submissions', async () => {
    await render();
    await choose('基线与初步诊断');
    await act(async () => root.render(null));
    await render();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('基线与初步诊断');
    const persisted = JSON.parse(localStorage.getItem('f311-program-reading-v1') ?? '{}');
    const reading = persisted.state.programs[PROGRAM_ID];
    expect(reading.preparationSection).toBe('baseline_diagnosis');
    expect(JSON.stringify(reading)).not.toContain('当前只能形成初步诊断');
    expect(JSON.stringify(reading)).not.toContain('submission');
  });

  it('mounts in the canonical Program journey under the product name 准备', async () => {
    expect(MOMENTS[1]).toBe('准备');
    await act(async () => root.render(<EvolutionMomentContext projection={fixtureProjection()} moment={1} />));
    expect(host.querySelector('[data-testid="evolution-preparation-workspace"]')).not.toBeNull();
    expect(host.textContent).toContain('Owner 已发布的实验材料与观测接入');
  });
});

describe('F311 preparation projection boundary', () => {
  it('retains a valid projection and fails closed on impossible activity or mismatched identities', () => {
    const value = evolutionPreparationFixture();
    expect(parseProgramProjection({ ...programFixture('instrumenting'), preparation: value })?.preparation).toEqual(
      value,
    );

    const spinning = structuredClone(value);
    const activity = spinning.sections.object_map.activities[0];
    if (!activity) throw new Error('active fixture missing');
    activity.state = 'terminal';
    expect(parseProgramProjection({ ...programFixture('instrumenting'), preparation: spinning })).toBeNull();

    const wrongProgram = structuredClone(value);
    wrongProgram.programId = 'evolution-program:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(parseProgramProjection({ ...programFixture('instrumenting'), preparation: wrongProgram })).toBeNull();

    const falseFresh = structuredClone(value);
    const current = falseFresh.sections.baseline_diagnosis.current;
    if (!current) throw new Error('baseline fixture missing');
    current.status = 'submitted';
    current.staleDependencies = [];
    expect(parseProgramProjection({ ...programFixture('instrumenting'), preparation: falseFresh })).toBeNull();
  });
});
