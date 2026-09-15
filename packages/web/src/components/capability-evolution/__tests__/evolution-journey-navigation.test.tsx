import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createEvolutionProgramSurface } from '@/components/workbench/real-surface-adapters';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { CapabilityEvolutionProgramDetail } from '../CapabilityEvolutionProgramDetail';
import { EvolutionProgramSurface } from '../EvolutionProgramSurface';
import { DEFAULT_READING, useEvolutionReading } from '../evolution-reading-state';
import { assetReviewFixture } from './evolution-asset-fixtures';
import { PROGRAM_ID, programFixture } from './evolution-fixtures';
import { ownerExplorationFixture } from './evolution-owner-exploration-fixture';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
const surface = createEvolutionProgramSurface(PROGRAM_ID);

describe('F311 journey navigation is reading, not lifecycle advancement', () => {
  let host: HTMLDivElement;
  let root: Root;
  const projection = programFixture('constituting');

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useEvolutionReading.setState({ programs: {}, workspaceProgramIds: {} });
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: surface.id,
    });
    api.fetch
      .mockReset()
      .mockImplementation(async (path: string) =>
        path.includes('/asset-review')
          ? Response.json(assetReviewFixture('v2'))
          : path.includes('/exploration')
            ? Response.json(ownerExplorationFixture())
            : Response.json(projection),
      );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function choose(label: string, container: Element = host) {
    const button = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="能力进化旅程"] button')].find(
      (node) => node.textContent === label,
    );
    expect(button, `the journey step ${label} must be a semantic control`).toBeDefined();
    await act(async () => button!.click());
    expect(button!.getAttribute('aria-pressed')).toBe('true');
  }

  it.each([
    'detail',
    'main',
  ] as const)('opens each real content panel in %s without writing Program state', async (mode) => {
    await act(async () =>
      root.render(
        mode === 'main' ? (
          <EvolutionProgramSurface programId={PROGRAM_ID} />
        ) : (
          <CapabilityEvolutionProgramDetail
            projection={projection}
            onClose={() => undefined}
            onOpenProgram={() => undefined}
          />
        ),
      ),
    );
    await choose('准备');
    expect(host.querySelector('[data-journey-panel="1"]')?.textContent).toContain('评估');
    await choose('探索进化');
    expect(host.querySelector('[data-journey-panel="2"]')?.textContent).toContain(
      mode === 'main' ? '尚无已发布的实验' : '尚未测量',
    );
    await choose('后续沿用');
    expect(host.querySelector('[data-journey-panel="3"]')?.textContent).toContain('后续任务');
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain('提出目标');
    expect(projection.program.stage).toBe('constituting');
    expect(projection.program.sequence).toBe(1);
    expect(api.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    await choose('提出目标');
    expect(host.querySelector('[data-journey-panel="0"]')?.textContent).toContain('目标');
  });

  it('shares the selected moment across narrow/main views while retaining exact version and history preferences', async () => {
    useEvolutionReading
      .getState()
      .update(PROGRAM_ID, { ...DEFAULT_READING, scroll: { detail: 0, judgment: 0, history: 73 } });
    await act(async () => root.render(<EvolutionProgramSurface programId={PROGRAM_ID} />));
    await choose('后续沿用');
    await act(async () => useF307ExperienceWorkbenchStore.getState().exitMainAreaAttention());
    expect(host.querySelector('[data-journey-panel="3"]')?.textContent).toContain('后续任务');
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.scroll.history).toBe(73);
    const persisted = JSON.parse(localStorage.getItem('f311-program-reading-v1')!);
    expect(persisted.state.programs[PROGRAM_ID].journeyMoment).toBe(3);
  });
});
