import { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createEvolutionProgramSurface } from '@/components/workbench/real-surface-adapters';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { EvolutionProgramSurface } from '../EvolutionProgramSurface';
import { openEvolutionReading, useEvolutionReading } from '../evolution-reading-state';
import { assetReviewFixture } from './evolution-asset-fixtures';
import { assetRef, PROGRAM_ID, programFixture } from './evolution-fixtures';
import { ownerExplorationFixture } from './evolution-owner-exploration-fixture';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
const surface = createEvolutionProgramSurface(PROGRAM_ID);

describe('F311 reading recovery and scroll continuity', () => {
  let host: HTMLDivElement;
  let root: Root;
  let mode: 'resolved' | 'empty' | 'loading' | 'error' | 'partial';
  let denied: 'asset' | 'program' | undefined;
  let commits: number;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mode = 'resolved';
    denied = undefined;
    commits = 0;
    useEvolutionReading.setState({ programs: {} });
    openEvolutionReading(PROGRAM_ID, 'history', assetRef('v1'));
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: surface.id,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    api.fetch.mockReset().mockImplementation(async (path: string) => {
      if (path.includes('/exploration')) return Response.json(ownerExplorationFixture());
      const asset = path.includes('/asset-review');
      if ((asset && denied === 'asset') || (!asset && denied === 'program'))
        return new Response('Session expired', { status: 403 });
      if (!asset) return Response.json(programFixture('observing'));
      if (mode === 'loading') return new Promise<Response>(() => undefined);
      if (mode === 'error') throw new Error('Network unavailable');
      const review = assetReviewFixture('v1');
      if (mode === 'empty') review.selected!.evidence = [];
      if (mode === 'partial') {
        review.selected!.evidence = [];
        review.blockers = [{ code: 'evidence_binding_unavailable', ownerRef: review.objectRef }];
      }
      return Response.json(review);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render() {
    await act(async () =>
      root.render(
        <Profiler
          id="program"
          onRender={() => {
            commits += 1;
          }}
        >
          <EvolutionProgramSurface programId={PROGRAM_ID} />
        </Profiler>,
      ),
    );
  }
  const viewport = () => host.querySelector<HTMLElement>('[data-testid="evolution-program-surface"]')!;
  async function click(label: string) {
    const button = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  }

  it.each(['loading', 'error'] as const)('does not claim absence while the owner read is %s', async (value) => {
    mode = value;
    await render();
    const evidence = host.querySelector('[aria-label="所选版本证据"]')!;
    const use = host.querySelector('[aria-label="后续任务实际使用"]')!;
    expect(evidence.textContent).toContain(value === 'loading' ? '正在读取' : '暂时无法确认');
    expect(use.textContent).toContain(value === 'loading' ? '正在读取' : '暂时无法确认');
    expect(host.textContent).not.toContain('尚未收到绑定');
    expect(host.textContent).not.toContain('还没有后续任务');
  });

  it('reports empty evidence and use only after the selected owner version resolves', async () => {
    mode = 'empty';
    await render();
    expect(host.textContent).toContain('尚未收到绑定此版本的对照基线证据');
    expect(host.textContent).toContain('还没有后续任务实际使用此版本的记录');
  });

  it('does not treat a partially resolved owner response with blockers as proof of empty collections', async () => {
    mode = 'partial';
    await render();
    expect(host.querySelector('[aria-label="所选版本证据"]')?.textContent).toContain('暂时无法确认');
    expect(host.querySelector('[aria-label="后续任务实际使用"]')?.textContent).toContain('暂时无法确认');
    expect(host.textContent).not.toContain('尚未收到绑定');
  });

  it.each([
    'asset',
    'program',
  ] as const)('clears persisted exact selections on %s authorization loss but keeps preferences', async (source) => {
    openEvolutionReading('another-program', 'judgment', assetRef('v2'));
    useEvolutionReading.getState().update(PROGRAM_ID, {
      scroll: { detail: 34, judgment: 150, history: 70 },
      preparationSection: 'measurement_plan',
      preparationGtSourceKey: 'business-facts',
    });
    await render();
    denied = source;
    await act(async () => window.dispatchEvent(new Event('focus')));
    const stored = JSON.parse(localStorage.getItem('f311-program-reading-v1')!).state.programs;
    expect(stored[PROGRAM_ID].selectedVersionRef).toBeUndefined();
    expect(stored['another-program'].selectedVersionRef).toBeUndefined();
    expect(stored[PROGRAM_ID].view).toBe('history');
    expect(stored[PROGRAM_ID].scroll).toEqual({ detail: 34, judgment: 150, history: 70 });
    expect(stored[PROGRAM_ID].preparationSection).toBe('measurement_plan');
    expect(stored[PROGRAM_ID].preparationGtSourceKey).toBe('business-facts');
  });

  it('keeps a return route and explicit retry when the promoted Program cannot be read', async () => {
    denied = 'program';
    await render();
    expect(host.querySelector('header h1')).not.toBeNull();
    expect(host.textContent).toContain('← 返回侧栏');
    denied = undefined;
    await click('重试');
    expect(host.textContent).toContain('更改历史');
    await click('← 返回侧栏');
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });

  it('refreshes the exact Program tab from the same canonical display name as the content', async () => {
    await render();
    expect(host.querySelector('h1')?.textContent).toBe('研发协作改进');
    expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces[0]?.title).toBe('研发协作改进');
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBe(surface.id);
  });

  it('lets an exact source override an unsaved reading position in the same view', async () => {
    await render();
    await act(async () => {
      viewport().scrollTop = 140;
      viewport().dispatchEvent(new Event('scroll'));
    });
    await act(async () => openEvolutionReading(PROGRAM_ID, 'history', assetRef('v2')));
    expect(viewport().scrollTop).toBe(0);
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.scroll.history).toBe(0);
  });

  it('does not rerender or persist during a scroll burst and restores positions after switching views', async () => {
    await render();
    const initialCommits = commits;
    const saved = localStorage.getItem('f311-program-reading-v1');
    for (let top = 1; top <= 100; top += 1) {
      await act(async () => {
        viewport().scrollTop = top;
        viewport().dispatchEvent(new Event('scroll'));
      });
    }
    expect(commits).toBe(initialCommits);
    expect(localStorage.getItem('f311-program-reading-v1')).toBe(saved);
    await click('探索工作面');
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.scroll.history).toBe(100);
    await click('更改历史');
    expect(viewport().scrollTop).toBe(100);
    await act(async () => {
      viewport().scrollTop = 130;
      viewport().dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.scroll.history).toBe(130);
  });
});
