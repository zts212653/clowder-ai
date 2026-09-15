import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useEvolutionReading } from '../evolution-reading-state';
import { EvolutionPreparationWorkspace } from '../preparation/EvolutionPreparationWorkspace';
import { PROGRAM_ID, programFixture } from './evolution-fixtures';
import { evolutionPreparationFixture } from './evolution-preparation-fixtures';

function choiceProjection() {
  const preparation = evolutionPreparationFixture();
  const current = preparation.sections.object_map.current!;
  const body = current.submission!.body;
  if (body.kind !== 'object_map') throw new Error('wrong fixture');
  const item = body.items[0]!;
  item.category = 'Harness / 陌生路由';
  item.label = '跨地区材料转交 sentinel';
  item.recommendation = { summary: '先比较失败路径', reason: '路由失败可以重放', basisRefs: item.sourceRefs };
  item.existingWork = { summary: '已记录三条失败路径', sourceRefs: item.sourceRefs };
  item.decision = {
    state: 'explore',
    reason: '局部比较在已有技术边界内',
    responsibility: { kind: 'cat', basis: 'technical' },
    basisRefs: item.sourceRefs,
  };
  return { ...programFixture('instrumenting'), preparation };
}

describe('preparation choice reading uses authored content', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useEvolutionReading.setState({ programs: {}, workspaceProgramIds: {} });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  });
  const render = async (projection = choiceProjection()) => {
    await act(async () => root.render(<EvolutionPreparationWorkspace projection={projection} />));
  };
  const choose = async (label: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      node.textContent?.includes(label),
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  it('shows a submitted technical recommendation and decision without an approval form or invented category', async () => {
    await render();
    const item = host.querySelector('[data-preparation-item="data"]')!;
    expect(item.querySelector('summary')?.textContent).toContain('Harness / 陌生路由');
    expect(item.querySelector('summary')?.textContent).toContain('纳入探索');
    expect(item.textContent).toContain('已记录三条失败路径');
    expect(item.textContent).toContain('codex-terra · 技术决定');
    expect(item.querySelectorAll('select,input,textarea')).toHaveLength(0);
    expect(host.querySelector('[data-preparation-item="records"]')?.textContent).toContain('尚未提交建议');
  });
  it('does not show a human choice as confirmed when its exact input is missing', async () => {
    const projection = choiceProjection();
    const current = projection.preparation.sections.object_map.current!;
    const body = current.submission!.body;
    if (body.kind !== 'object_map') throw new Error('wrong fixture');
    const item = body.items[0]!;
    item.decision = {
      state: 'excluded',
      reason: '人的预算选择',
      basisRefs: item.sourceRefs,
      responsibility: { kind: 'human', input: { threadId: 'thread-owner', messageId: 'input-owner' } },
    };
    current.inputSources = [
      { itemId: item.itemId, threadId: 'thread-owner', messageId: 'input-owner', status: 'unavailable' },
    ];
    await render(projection);
    expect(host.querySelector('[data-preparation-item="data"] summary')?.textContent).toContain('决定来源待核实');
    expect(host.querySelector('[data-preparation-item="data"] summary')?.textContent).not.toContain('暂不纳入');
    expect(host.textContent).toContain('当前决定不能确认');
    current.inputSources[0] = {
      ...current.inputSources[0]!,
      status: 'available',
      author: 'human',
      occurredAt: '2026-09-14T00:00:00.000Z',
    };
    await render(projection);
    expect(host.querySelector('[data-preparation-item="data"] summary')?.textContent).toContain('暂不纳入');
    expect(host.textContent).toContain('回读人的原输入');
  });
  it('returns to the exact historical rubric after the current submission changes', async () => {
    const projection = choiceProjection();
    await render(projection);
    await choose('好坏规约');
    const source = host.querySelector<HTMLButtonElement>(
      '[data-preparation-criterion="professional-judgment"] [data-gt-source-jump]',
    )!;
    await act(async () => source.click());
    const section = projection.preparation.sections.success_contract;
    const previous = structuredClone(section.current!);
    section.history = [previous];
    section.current = structuredClone(previous);
    section.current.ref.version = `sha256:${'a'.repeat(64)}`;
    section.current.submission!.revision = section.current.ref.version;
    await render(projection);
    await choose('返回规约：专业判断');
    const returned = [
      ...host.querySelectorAll<HTMLDetailsElement>('[data-preparation-criterion="professional-judgment"]'),
    ].find((node) => node.dataset.preparationRevision === previous.ref.version)!;
    expect(returned.open).toBe(true);
    expect(returned.closest<HTMLDetailsElement>('.evolution-preparation-history')?.open).toBe(true);
    expect(document.activeElement).toBe(returned.querySelector('summary'));
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.preparationReturn?.revision).toBe(previous.ref.version);
  });
  it('uses the measurement revision that actually cites the rubric instead of a newer unrelated source', async () => {
    const projection = choiceProjection();
    const measurement = projection.preparation.sections.measurement_plan;
    const original = structuredClone(measurement.current!);
    if (original.submission!.body.kind !== 'measurement_plan') throw new Error('wrong fixture');
    original.submission!.body.gtSources[1]!.label = '原规约对应的取证版本';
    measurement.history = [original];
    measurement.current = structuredClone(original);
    measurement.current.ref.version = `sha256:${'b'.repeat(64)}`;
    measurement.current.submission!.revision = measurement.current.ref.version;
    measurement.current.dependencies = [];
    measurement.current.submission!.dependsOn = [];
    if (measurement.current.submission!.body.kind !== 'measurement_plan') throw new Error('wrong fixture');
    measurement.current.submission!.body.gtSources[1]!.label = '不对应旧规约的新来源';
    await render(projection);
    await choose('好坏规约');
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[data-preparation-criterion="professional-judgment"] [data-gt-source-jump]')!
        .click(),
    );
    expect(host.querySelector('[data-gt-source-key="domain-precedents"]')?.textContent).toContain(
      '原规约对应的取证版本',
    );
    expect(host.querySelector('[data-gt-source-key="domain-precedents"]')?.textContent).not.toContain(
      '不对应旧规约的新来源',
    );
  });
});
