import { refIdentity } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapabilityEvolutionWorkspaceSurface } from '@/components/workbench/capability-evolution-workspace-adapter';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createEvolutionProgramSurface } from '@/components/workbench/real-surface-adapters';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { useChatStore } from '@/stores/chatStore';
import { CapabilityEvolutionWorkspace } from '../CapabilityEvolutionWorkspace';
import { EvolutionProgramSurface } from '../EvolutionProgramSurface';
import { EvolutionVersionEvidence } from '../EvolutionVersionEvidence';
import {
  evolutionReadingHref,
  hydrateEvolutionFromCurrentUrl,
  openEvolutionTarget,
  readEvolutionTarget,
} from '../evolution-navigation';
import { DEFAULT_READING, openEvolutionReading, useEvolutionReading } from '../evolution-reading-state';
import { assetReviewFixture } from './evolution-asset-fixtures';
import { assetRef, PROGRAM_ID, programFixture } from './evolution-fixtures';
import { ownerExplorationFixture } from './evolution-owner-exploration-fixture';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
const surface = createEvolutionProgramSurface(PROGRAM_ID);

describe('F311 exact version reading in shared owner surfaces', () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: string;
  let unavailable: boolean;
  let wrongVersion: boolean;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    current = 'v2';
    unavailable = false;
    wrongVersion = false;
    useEvolutionReading.setState({ programs: {}, workspaceProgramIds: {} });
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: surface.id,
    });
    useChatStore.setState({ currentThreadId: 'thread-reading', workspaceOpenRequest: null });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    api.fetch.mockReset().mockImplementation(async (path: string) => {
      if (path.includes('/exploration'))
        return unavailable ? new Response('Denied', { status: 401 }) : Response.json(ownerExplorationFixture(current));
      if (path.includes('/asset-review')) {
        if (unavailable) return new Response('Session expired', { status: 401 });
        const value = new URL(path, 'http://localhost').searchParams.get('selectedVersionRef');
        const version = value ? (JSON.parse(value) as { version: string }).version : 'v2';
        return Response.json(assetReviewFixture(wrongVersion ? 'v3' : version, current));
      }
      const projection = programFixture('observing');
      return Response.json(path.endsWith('/programs') ? { programs: [projection] } : projection);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.history.replaceState({}, '', '/');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render() {
    await act(async () =>
      root.render(
        <>
          <CapabilityEvolutionWorkspace targetThreadId="thread-reading" onOpenProgram={() => undefined} />
          <EvolutionProgramSurface programId={PROGRAM_ID} />
        </>,
      ),
    );
  }
  async function click(text: string, parent: Element = host) {
    const button = [...parent.querySelectorAll('button')].find((node) => node.textContent === text);
    if (!button) throw new Error(`Missing button ${text}`);
    await act(async () => button.click());
  }
  const program = () => host.querySelector<HTMLElement>('[data-testid="evolution-program-surface"]')!;

  it('keeps selected history and scroll while a fresh owner adoption updates all mounted consumers', async () => {
    openEvolutionReading(PROGRAM_ID, 'history', assetRef('v1'));
    await render();
    const selected = useEvolutionReading.getState().programs[PROGRAM_ID];
    expect(selected?.selectedVersionRef?.version).toBe('v1');
    expect(program().textContent).toContain('v1 的人话变化说明');
    expect(program().textContent).not.toContain('v2 comparison_baseline');
    await act(async () => {
      program().scrollTop = 180;
      program().dispatchEvent(new Event('scroll'));
    });
    current = 'v3';
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(program().textContent).toContain('v3当前采用');
    expect(host.querySelector('[data-testid="capability-evolution-workspace"]')?.textContent).toContain('v3');
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.selectedVersionRef?.version).toBe('v1');
    expect(program().scrollTop).toBe(180);
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.scroll.history).toBe(180);
    expect(program().textContent).toContain('v1 comparison_baseline');
    expect(program().textContent).not.toContain('后续任务已实际使用这个版本');
  });

  it('keeps three evidence roles bound to the selected version and needs an applied-use receipt', async () => {
    openEvolutionReading(PROGRAM_ID, 'judgment', assetRef('v1'));
    await render();
    expect(program().textContent).toContain('还没有后续任务实际使用');
    await act(async () => useEvolutionReading.getState().update(PROGRAM_ID, { selectedVersionRef: assetRef('v2') }));
    expect(program().textContent).toContain('v2 comparison_baseline');
    expect(program().textContent).toContain('v2 candidate_independent_verification');
    expect(program().textContent).toContain('v2 post_adoption_observation');
    expect(program().textContent).not.toContain('v1 comparison_baseline');
    expect(program().textContent).toContain('后续任务已实际使用这个版本');
  });

  it('never substitutes another version when the exact owner selection cannot be resolved', async () => {
    wrongVersion = true;
    openEvolutionReading(PROGRAM_ID, 'judgment', assetRef('missing-version'));
    await render();
    expect(program().textContent).toContain('这个版本暂时无法定位');
    expect(program().textContent).not.toContain('v3 comparison_baseline');
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.selectedVersionRef?.version).toBe('missing-version');
  });

  it('clears live current claims on loss of owner read authorization across every consumer', async () => {
    await render();
    await click('探索进化', program());
    expect(program().querySelector('[aria-label="当前沿用"]')?.textContent).toContain('补充边界示例');
    unavailable = true;
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(program().querySelector('[aria-label="当前沿用"]')?.textContent ?? '').not.toContain('补充边界示例');
    expect(program().querySelector('[aria-label="阅读版本"]')?.textContent ?? program().textContent).not.toContain(
      'v2当前采用',
    );
    expect(host.querySelector('[data-testid="capability-evolution-workspace"]')?.textContent).not.toContain(
      '当前采用 v2',
    );
  });

  it('restores independent judgment, history and rail scroll positions on normal return', async () => {
    openEvolutionReading(PROGRAM_ID, 'judgment', assetRef('v1'));
    useEvolutionReading.getState().update(PROGRAM_ID, { scroll: { detail: 34, judgment: 150, history: 70 } });
    await render();
    expect(program().scrollTop).toBe(150);
    await click('更改历史', program());
    expect(program().scrollTop).toBe(70);
    await click('← 返回侧栏', program());
    expect(program().dataset.readingView).toBe('detail');
    expect(program().scrollTop).toBe(34);
    await click('查看历史 →', program());
    expect(program().scrollTop).toBe(70);
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.selectedVersionRef?.version).toBe('v1');
  });

  it('returns to all projects in one click without discarding the exact Program reading position', async () => {
    const home = createCapabilityEvolutionWorkspaceSurface('thread-reading');
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([surface, home]) });
    openEvolutionReading(PROGRAM_ID, 'history', assetRef('v1'));
    useEvolutionReading.getState().update(PROGRAM_ID, { scroll: { detail: 34, judgment: 150, history: 70 } });
    await render();
    const workspace = host.querySelector<HTMLElement>('[data-testid="capability-evolution-workspace"]')!;
    await act(async () =>
      workspace.querySelector<HTMLButtonElement>(`[data-testid="capability-evolution-program-${PROGRAM_ID}"]`)!.click(),
    );
    expect(workspace.querySelector('[data-testid="capability-evolution-program-detail"]')).not.toBeNull();
    await click('← 返回侧栏', program());
    await click('← 全部项目', program());
    expect(workspace.querySelector(`[data-testid="capability-evolution-program-${PROGRAM_ID}"]`)).not.toBeNull();
    expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(home.id);
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.selectedVersionRef).toEqual(assetRef('v1'));
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.scroll.history).toBe(70);
  });

  it('returns to a sidecar workspace list without promoting it or losing its reading position', async () => {
    const home = createCapabilityEvolutionWorkspaceSurface('thread-reading');
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'open-sidecar',
      surface: home,
      entitlement: { kind: 'user', reason: 'sidecar-action' },
    });
    openEvolutionReading(PROGRAM_ID, 'history', assetRef('v1'));
    useEvolutionReading.getState().update(PROGRAM_ID, { scroll: { detail: 34, judgment: 150, history: 70 } });
    useEvolutionReading.getState().selectWorkspaceProgram('another-thread', PROGRAM_ID);
    await render();
    const workspace = host.querySelector<HTMLElement>('[data-testid="capability-evolution-workspace"]')!;
    workspace.scrollTop = 110;
    await act(async () =>
      workspace.querySelector<HTMLButtonElement>(`[data-testid="capability-evolution-program-${PROGRAM_ID}"]`)!.click(),
    );
    expect(workspace.querySelector('[data-testid="capability-evolution-program-detail"]')).not.toBeNull();
    await click('← 返回侧栏', program());
    const layout = useF307ExperienceWorkbenchStore.getState().layout;
    expect(layout.sidecar).toEqual(home);
    await click('← 全部项目', program());
    expect(useF307ExperienceWorkbenchStore.getState().layout).toBe(layout);
    expect(workspace.querySelector(`[data-testid="capability-evolution-program-${PROGRAM_ID}"]`)).not.toBeNull();
    expect(workspace.scrollTop).toBe(110);
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.selectedVersionRef).toEqual(assetRef('v1'));
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.scroll.history).toBe(70);
    expect(useEvolutionReading.getState().workspaceProgramIds['another-thread']).toBe(PROGRAM_ID);
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });

  it('opens the workspace list for a direct Program source and leaves another thread selection intact', async () => {
    useEvolutionReading.getState().selectWorkspaceProgram('another-thread', PROGRAM_ID);
    await render();
    await click('← 返回侧栏', program());
    await click('← 全部项目', program());
    const home = createCapabilityEvolutionWorkspaceSurface('thread-reading');
    expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(home.id);
    expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toContainEqual(home);
    expect(useEvolutionReading.getState().workspaceProgramIds['another-thread']).toBe(PROGRAM_ID);
  });

  it('keeps an insufficient evidence verdict visible even when its source supplies a title', async () => {
    const selected = assetReviewFixture('v1').selected!;
    selected.evidence[0]!.status = 'insufficient';
    await act(async () => root.render(<EvolutionVersionEvidence selected={selected} />));
    expect(host.textContent).toContain('v1 comparison_baseline');
    expect(host.textContent).toContain('证据仍不足');
  });

  it('exposes a source link for the exact selected version without changing adoption', async () => {
    openEvolutionReading(PROGRAM_ID, 'history', assetRef('v1'));
    await render();
    const link = program().querySelector<HTMLAnchorElement>('[data-testid="evolution-version-link"]');
    expect(link).not.toBeNull();
    expect(readEvolutionTarget(new URL(link!.href))).toEqual({
      programId: PROGRAM_ID,
      view: 'history',
      versionRef: assetRef('v1'),
    });
    expect(program().textContent).toContain('v2当前采用');
  });

  it('persists only reading preferences and consumes exact source links once', () => {
    openEvolutionReading(PROGRAM_ID, 'history', assetRef('v1'));
    useEvolutionReading.getState().update(PROGRAM_ID, { scroll: { detail: 22, judgment: 99, history: 88 } });
    const target = { programId: PROGRAM_ID, versionRef: assetRef('v2'), view: 'judgment' as const };
    const href = evolutionReadingHref(target, window.location.href);
    window.history.replaceState({}, '', href);
    hydrateEvolutionFromCurrentUrl();
    const reading = useEvolutionReading.getState().programs[PROGRAM_ID];
    expect(reading?.selectedVersionRef).toEqual(target.versionRef);
    expect(reading?.scroll).toEqual({ detail: 22, judgment: 0, history: 88 });
    expect(window.location.search).toBe('');
    expect(useChatStore.getState().workspaceOpenRequest?.target).toEqual({
      kind: 'evolution-program',
      programId: PROGRAM_ID,
    });
    openEvolutionReading(PROGRAM_ID, 'history', assetRef('v3'));
    hydrateEvolutionFromCurrentUrl();
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.selectedVersionRef?.version).toBe('v3');
    const persisted = JSON.parse(localStorage.getItem('f311-program-reading-v1') ?? '{}');
    expect(Object.keys(persisted.state.programs[PROGRAM_ID]).sort()).toEqual([
      'journeyMoment',
      'scroll',
      'selectedVersionRef',
      'view',
    ]);
  });

  it('rejects partial or malformed source refs rather than turning them into default selection', () => {
    for (const value of [
      '{}',
      '{',
      JSON.stringify({ version: 'v1' }),
      JSON.stringify({ ...assetRef('v1'), assetId: '' }),
    ]) {
      const url = new URL(`http://localhost/?evolutionProgram=${PROGRAM_ID}`);
      url.searchParams.set('evolutionVersion', value);
      expect(readEvolutionTarget(url)).toBeUndefined();
    }
    openEvolutionTarget({ programId: PROGRAM_ID, view: 'history', versionRef: assetRef('v1') });
    openEvolutionReading(PROGRAM_ID, 'judgment');
    expect(
      refIdentity(useEvolutionReading.getState().programs[PROGRAM_ID]?.selectedVersionRef ?? assetRef('invalid')),
    ).toBe(refIdentity(assetRef('v1')));
    expect(DEFAULT_READING.scroll).toEqual({ detail: 0, judgment: 0, history: 0 });
  });
});
