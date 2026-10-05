import { evolutionExplorationNodeSchema, evolutionExplorationReviewV1Schema, refIdentity } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  explorationFixture,
  objectRef,
  source,
} from '../../../../../api/test/capability-evolution-exploration.helper.mjs';
import { parseProgramProjection } from '../evolution-program-projection';
import { useEvolutionReading } from '../evolution-reading-state';
import { ExplorationLineage } from '../exploration/ExplorationLineage';
import { ExplorationPairedResults } from '../exploration/ExplorationPairedResults';
import { compareExplorationRecords } from '../exploration/exploration-comparison';
import { layoutExplorationLineage } from '../exploration/exploration-lineage';
import { DEFAULT_EXPLORATION, explorationReadingSchema } from '../exploration/exploration-reading';
import { EvolutionMomentContext } from '../journey/EvolutionMomentContext';
import { programFixture } from './evolution-fixtures';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));

describe('accepted exploration reading experience', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    useEvolutionReading.setState({ programs: {} });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    });
    api.fetch.mockReset().mockImplementation(async (path: string) => {
      const url = new URL(path, 'https://cafe.invalid');
      return url.pathname.endsWith('/exploration')
        ? Response.json(explorationFixture({ withDetail: url.searchParams.has('selectedExperimentRef') }))
        : new Response('{}', { status: 404 });
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function showProgram() {
    const value = programFixture('observing');
    value.program.objectRef = objectRef;
    const projection = parseProgramProjection(value)!;
    await act(async () =>
      root.render(<EvolutionMomentContext projection={projection} moment={2} explorationMode="workspace" />),
    );
    return value.program.programId;
  }

  it('reads a non-duck API comparison from its verdicts and output, without treating bigger numbers as better', async () => {
    const review = evolutionExplorationReviewV1Schema.parse(explorationFixture({ withDetail: true }));
    if (review.status !== 'resolved' || review.details[0]?.status !== 'resolved') throw Error('unresolved fixture');
    const experiment = review.experiments[0]!;
    const record = review.details[0].records[0]!;
    const right = { experiment, records: [record] };
    const left = {
      experiment: { ...experiment, experimentRef: source('before'), title: '修改前的身份契约' },
      records: [
        {
          ...record,
          experimentRef: source('before'),
          recordRef: source('before-record'),
          output: [{ label: 'HTTP', value: '200' }],
          values: { status: 200 },
          result: { status: 'violated' as const, label: '未登录却获准读取' },
        },
      ],
    };
    await act(async () =>
      root.render(
        <ExplorationPairedResults
          programId={review.programRef.ownerStateRef}
          left={left}
          right={right}
          result={compareExplorationRecords(left, right, 'full')}
          reading={DEFAULT_EXPLORATION}
          onChange={() => {}}
          onRetry={() => {}}
        />,
      ),
    );
    expect(host.querySelector('.exploration-pair-focus h3')?.textContent).toBe('未登录读取');
    expect(host.querySelector('.exploration-slice-filters')?.textContent).toContain('改善 1');
    expect([...host.querySelectorAll('.exploration-output-reading dd')].map((el) => el.textContent)).toEqual([
      '200',
      '401',
    ]);
    expect(host.querySelector('.exploration-outcome[data-result="satisfied"]')?.textContent).toContain('读取被拒绝');
    expect(host.querySelector('.exploration-trace')).toBeNull();
    expect(host.textContent).not.toContain('触球');
  });

  it('keeps version changes and experiment counts in the adjacent map without opening a modal', async () => {
    const programId = await showProgram();
    expect(host.querySelector('dialog')).toBeNull();
    const node = host.querySelector<HTMLButtonElement>('.exploration-node[aria-pressed="true"]');
    expect(host.querySelector('.exploration-version-summary')?.textContent).toContain('按请求身份拒绝读取');
    expect(host.querySelector('.exploration-run-picker')?.textContent).toContain('更换实验 · 1 次');
    expect(node?.textContent).not.toContain('当前沿用');
    expect(useEvolutionReading.getState().programs[programId]?.exploration?.draft.text ?? '').toBe('');
  });

  it('shows the actual change in a node preview instead of its field heading', async () => {
    const node = evolutionExplorationNodeSchema.parse({
      kind: 'public_archive',
      nodeRef: source('preview'),
      sourceRef: source('preview-source'),
      title: '持续跟球',
      summary: '完整说明',
      parentEdges: [],
      changes: [{ label: '改了什么', detail: '停步后继续追踪移动球', sourceRef: source('change') }],
    });
    await act(async () =>
      root.render(
        <ExplorationLineage
          nodes={[node]}
          currentKeys={new Set()}
          viewport={DEFAULT_EXPLORATION.viewport}
          onViewport={() => {}}
          onSelect={() => {}}
        />,
      ),
    );
    expect(host.querySelector('.exploration-node-summary')?.textContent).toBe('停步后继续追踪移动球');
  });

  it('keeps sample and judgment context beside results and opens complete conditions in place', async () => {
    await showProgram();
    expect(host.querySelector('.exploration-condition-line')?.textContent).toContain('固定输入集');
    const conditions = [...host.querySelectorAll('button')].find((button) => button.textContent === '评估与观测');
    await act(async () => conditions!.click());
    const summary = host.querySelector('[aria-label="当前实验条件"]');
    expect(summary).not.toBeNull();
    expect(summary?.closest('details:not([open])')).toBeNull();
    for (const label of ['隔离 Node 运行', '固定输入集', '身份拒绝契约', 'API 契约', '本次调用']) {
      expect(summary?.textContent).toContain(label);
    }
    expect(host.querySelector<HTMLDetailsElement>('.exploration-condition-details')?.open).toBe(false);
  });

  it('opens the full lineage on request while keeping version selection available in a narrow reading', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
    await showProgram();
    expect(host.querySelector('dialog')).toBeNull();
    expect(host.querySelector('select[aria-label="选择阅读版本"]')).not.toBeNull();
    const graph = [...host.querySelectorAll('button')].find((button) => button.textContent === '完整谱系');
    await act(async () => graph!.click());
    expect(host.querySelector<HTMLDialogElement>('dialog')?.open).toBe(true);
    const parentEscape = vi.fn();
    document.addEventListener('keydown', parentEscape);
    try {
      host
        .querySelector('dialog button')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(parentEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', parentEscape);
    }
  });

  it('repairs an old tiny saved zoom using the actual viewport without selecting another version', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(210);
    const node = evolutionExplorationNodeSchema.parse({
      kind: 'public_archive',
      nodeRef: source('tiny'),
      sourceRef: source('tiny-source'),
      title: '基线',
      summary: '基线说明',
      parentEdges: [],
      changes: [],
    });
    const onViewport = vi.fn();
    const onSelect = vi.fn();
    await act(async () =>
      root.render(
        <ExplorationLineage
          nodes={[node]}
          currentKeys={new Set()}
          selected={refIdentity(node.nodeRef)}
          viewport={{ ...DEFAULT_EXPLORATION.viewport, zoom: 0.01, framing: 'manual' }}
          onViewport={onViewport}
          onSelect={onSelect}
        />,
      ),
    );
    expect(onViewport.mock.calls.at(-1)?.[0].zoom).toBeGreaterThanOrEqual(0.8);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not overwrite the map recenter when filling the default experiment for a newly read version', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(210);
    const program = programFixture('observing');
    const publication = explorationFixture();
    useEvolutionReading.getState().update(program.program.programId, {
      exploration: {
        ...DEFAULT_EXPLORATION,
        selectedNodeRef: publication.nodes[0]!.nodeRef,
        viewport: { ...DEFAULT_EXPLORATION.viewport, x: -1600 },
      },
    });
    const programId = await showProgram();
    const embedded = useEvolutionReading.getState().programs[programId]?.exploration;
    expect(embedded?.selectedExperimentRef).toEqual(publication.experiments[0]!.experimentRef);
    expect(embedded?.viewport.x).toBeGreaterThanOrEqual(0);
    expect(embedded?.viewport.x).toBeLessThan(320);
    const graph = [...host.querySelectorAll('button')].find((button) => button.textContent === '完整谱系');
    await act(async () => graph!.click());
    const saved = useEvolutionReading.getState().programs[programId]?.exploration;
    expect(saved?.selectedExperimentRef).toEqual(publication.experiments[0]!.experimentRef);
    expect(saved?.viewport.x).toBeGreaterThanOrEqual(0);
    expect(saved?.viewport.x).toBeLessThan(320);
  });

  it('fits a deep lineage into the actual viewport and persists that view without changing the selection', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(210);
    const template = evolutionExplorationNodeSchema.parse(explorationFixture().nodes[0]);
    if (template.kind !== 'owner_version') throw new Error('Expected the real owner-version fixture');
    const nodes = Array.from({ length: 512 }, (_, index) => ({
      ...template,
      nodeRef: { ...template.nodeRef, version: `v${index}` },
      versionRef: { ...template.versionRef, version: `v${index}` },
      title: `v${index}`,
      summary: `第 ${index} 组改动`,
      parentEdges: index
        ? [{ parentNodeRef: { ...template.nodeRef, version: `v${index - 1}` }, sourceRef: source('lineage') }]
        : [],
    }));
    const onViewport = vi.fn();
    const onSelect = vi.fn();
    await act(async () =>
      root.render(
        <ExplorationLineage
          nodes={nodes}
          selected={refIdentity(nodes.at(-1)!.nodeRef)}
          currentKeys={new Set()}
          viewport={DEFAULT_EXPLORATION.viewport}
          onViewport={onViewport}
          onSelect={onSelect}
        />,
      ),
    );
    onViewport.mockClear();
    const fit = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('看全图'));
    expect(fit).toBeDefined();
    await act(async () => fit!.click());
    const view = onViewport.mock.calls.at(-1)![0];
    const layout = layoutExplorationLineage(nodes, []);
    expect(view.x).toBeGreaterThanOrEqual(0);
    expect(view.y).toBeGreaterThanOrEqual(0);
    expect(view.x + layout.width * view.zoom).toBeLessThanOrEqual(320);
    expect(view.y + layout.height * view.zoom).toBeLessThanOrEqual(210);
    expect(view.zoom).toBeLessThan(0.5);
    expect(explorationReadingSchema.safeParse({ ...DEFAULT_EXPLORATION, viewport: view }).success).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    const locate = host.querySelector<HTMLButtonElement>('button[aria-label="定位阅读版"]');
    await act(async () => locate!.click());
    const readable = onViewport.mock.calls.at(-1)![0];
    expect(readable.zoom).toBeGreaterThanOrEqual(1);
    expect(explorationReadingSchema.safeParse({ ...DEFAULT_EXPLORATION, viewport: readable }).success).toBe(true);
  });
});
