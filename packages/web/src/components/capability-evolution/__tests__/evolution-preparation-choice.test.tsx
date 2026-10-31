import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jumpToApprovalAnchor } from '@/components/ApprovalProvenanceLinks';
import { useEvolutionReading } from '../evolution-reading-state';
import { EvolutionPreparationWorkspace } from '../preparation/EvolutionPreparationWorkspace';
import { PROGRAM_ID, programFixture } from './evolution-fixtures';
import { evolutionPreparationFixture } from './evolution-preparation-fixtures';

vi.mock('@/components/ApprovalProvenanceLinks', () => ({ jumpToApprovalAnchor: vi.fn() }));

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
    vi.clearAllMocks();
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
    expect(host.querySelector('[data-preparation-item="records"] > summary')?.textContent).not.toContain('猫的建议');
  });
  it('reads the concrete object first and accepts an omitted optional category', async () => {
    const projection = choiceProjection();
    const body = projection.preparation.sections.object_map.current!.submission!.body;
    if (body.kind !== 'object_map') throw new Error('wrong fixture');
    delete body.items[0]!.category;
    await render(projection);
    const summary = host.querySelector('[data-preparation-item="data"] > summary')!;
    expect(summary.textContent).toMatch(/^跨地区材料转交 sentinel/u);
    expect(summary.textContent).not.toContain('类别尚未提交');
    expect(summary.textContent).toContain(body.items[0]!.why);
    expect(summary.textContent).toContain('路由失败可以重放');
    expect(summary.textContent).not.toContain('来源与范围');
    expect(summary.textContent).toContain('查看依据与原件');
    expect(host.querySelector('[data-preparation-item="records"] > summary')?.textContent).not.toContain('猫的建议');
  });
  it('does not turn an omitted recommendation into missing work or hide an explicitly undecided choice', async () => {
    const projection = choiceProjection();
    const body = projection.preparation.sections.object_map.current!.submission!.body;
    if (body.kind !== 'object_map') throw new Error('wrong fixture');
    const item = body.items[0]!;
    delete item.recommendation;
    item.decision = { state: 'undecided', reason: '实际加载的方法尚未核实', neededFrom: 'cat' };
    item.nextAction = '回读这次调用实际加载的方法版本';
    await render(projection);
    const row = host.querySelector('[data-preparation-item="data"]')!;
    expect(row.querySelector('summary')?.textContent).not.toContain('猫的建议');
    expect(row.textContent).not.toMatch(/尚未提交建议|无须建议/u);
    expect(row.textContent).toContain('实际加载的方法尚未核实');
    expect(row.textContent).toContain(item.nextAction);
    expect(row.textContent).toContain('未决定');
  });
  it('keeps an unconnected Git reference unverified and does not replace its version with a workspace file', async () => {
    const projection = choiceProjection();
    const body = projection.preparation.sections.object_map.current!.submission!.body;
    if (body.kind !== 'object_map') throw new Error('wrong fixture');
    body.items[0]!.sourceRefs = [{ ownerFeatureId: 'F311', ownerStateRef: `git:${'a'.repeat(40)}:method/old.md` }];
    await render(projection);
    const item = host.querySelector('[data-preparation-item="data"]')!;
    expect(item.textContent).toContain('原件未核读');
    expect(item.textContent).toContain(`git:${'a'.repeat(40)}:method/old.md`);
    expect(item.querySelector('a[href*="old.md"]')).toBeNull();
  });
  it('opens only the exact resolved source and removes the entrance when that source is unavailable', async () => {
    const projection = choiceProjection();
    const current = projection.preparation.sections.object_map.current!;
    const body = current.submission!.body;
    if (body.kind !== 'object_map') throw new Error('wrong fixture');
    const source = { ownerFeatureId: 'F117', ownerStateRef: 'message:original' };
    body.items[0]!.sourceRefs = [source];
    current.evidenceSources = [
      {
        sourceKey: 'data',
        status: 'available',
        refs: [
          {
            ref: { ...source, version: 'different-version' },
            status: 'available',
            threadId: 'source-thread',
            messageId: 'original',
          },
        ],
      },
    ];
    await render(projection);
    expect(host.querySelector('.evolution-preparation-object-sources button')).toBeNull();
    current.evidenceSources[0]!.refs[0]!.ref = source;
    await render(projection);
    const button = host.querySelector<HTMLButtonElement>('.evolution-preparation-object-sources button');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(jumpToApprovalAnchor).toHaveBeenCalledExactlyOnceWith('source-thread', 'original');
    current.evidenceSources[0]!.refs[0]!.status = 'unavailable';
    await render(projection);
    expect(host.querySelector('.evolution-preparation-object-sources button')).toBeNull();
    expect(host.querySelector('.evolution-preparation-object-sources')?.textContent).toContain('原件当前不可读');
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
