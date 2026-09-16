import { evolutionExplorationNodeSchema, refIdentity } from '@cat-cafe/shared';
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

  it('lets a fresh reader see the version change and real experiment count directly on the map', async () => {
    const programId = await showProgram();
    expect(host.querySelector<HTMLDetailsElement>('[aria-label="版本谱系"]')?.open).toBe(true);
    const node = host.querySelector<HTMLButtonElement>('.exploration-node[aria-pressed="true"]');
    expect(node?.textContent).toContain('按请求身份拒绝读取');
    expect(node?.textContent).toContain('1 轮实验');
    expect(node?.textContent).not.toContain('当前沿用');
    expect(useEvolutionReading.getState().programs[programId]?.exploration?.draft.text ?? '').toBe('');
  });

  it('keeps environment, samples, measurement and GT visible before expanding source details', async () => {
    await showProgram();
    const summary = host.querySelector('[aria-label="当前实验条件"]');
    expect(summary).not.toBeNull();
    expect(summary?.closest('details:not([open])')).toBeNull();
    for (const label of ['隔离 Node 运行', '固定输入集', '身份拒绝契约', 'API 契约', '本次调用']) {
      expect(summary?.textContent).toContain(label);
    }
    expect(host.querySelector<HTMLDetailsElement>('.exploration-condition-details')?.open).toBe(false);
  });

  it('starts a narrow reading with the map folded while preserving an explicit choice to open it', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
    const programId = await showProgram();
    expect(host.querySelector<HTMLDetailsElement>('[aria-label="版本谱系"]')?.open).toBe(false);
    await act(async () =>
      useEvolutionReading.getState().update(programId, {
        exploration: { ...useEvolutionReading.getState().programs[programId]!.exploration!, lineageCollapsed: false },
      }),
    );
    expect(host.querySelector<HTMLDetailsElement>('[aria-label="版本谱系"]')?.open).toBe(true);
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
    const locate = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('定位阅读版'));
    await act(async () => locate!.click());
    const readable = onViewport.mock.calls.at(-1)![0];
    expect(readable.zoom).toBeGreaterThanOrEqual(1);
    expect(explorationReadingSchema.safeParse({ ...DEFAULT_EXPLORATION, viewport: readable }).success).toBe(true);
  });
});
