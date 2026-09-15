import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { model, TEAM_CATALOG } from './team-panel-fixtures';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  useRoutingContext: vi.fn(),
  catalog: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../useRoutingContext', () => ({
  useRoutingContext: () => mocks.useRoutingContext(),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [...mocks.catalog.values()],
    isLoading: false,
    hasFetched: true,
    getCatById: (catId: string) => mocks.catalog.get(catId),
    refresh: vi.fn(),
  }),
}));

describe('F293 TeamWorkspacePanel recovery and honesty', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    mocks.refresh.mockReset();
    mocks.catalog.clear();
    const { resetTeamReading } = await import('../team-reading-state');
    resetTeamReading();
    for (const [catId, cat] of Object.entries(TEAM_CATALOG)) mocks.catalog.set(catId, cat);
    mocks.useRoutingContext.mockReturnValue({ data: model, loading: false, error: null, refresh: mocks.refresh });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('says a stale read is stale instead of presenting the previous snapshot as fresh', async () => {
    mocks.useRoutingContext.mockReturnValue({
      data: model,
      loading: false,
      error: '最新一次读取失败',
      refresh: mocks.refresh,
    });
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));

    const stale = container.querySelector('[data-testid="team-stale-read"]');
    expect(stale).not.toBeNull();
    expect(stale?.textContent).toContain('最新一次读取失败');
    // The previous content is still readable — it is just no longer claimed to be current.
    expect(container.querySelector('[data-testid="team-cat-codex-sol"]')).not.toBeNull();
    const retry = stale?.querySelector<HTMLButtonElement>('[data-testid="team-stale-retry"]');
    expect(retry).not.toBeNull();
    act(() => retry?.click());
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('shows an honest error state and retries without changing navigation', async () => {
    mocks.useRoutingContext.mockReturnValue({
      data: null,
      loading: false,
      error: '暂时无法读取',
      refresh: mocks.refresh,
    });
    const onSubjectChange = vi.fn();
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () =>
      root.render(<TeamWorkspacePanel subject={{ type: 'cat', id: 'codex-sol' }} onSubjectChange={onSubjectChange} />),
    );

    expect(container.textContent).toContain('暂时无法读取');
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="team-retry"]');
    act(() => retry?.click());
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(onSubjectChange).not.toHaveBeenCalled();
  });

  it('does not claim a provider is running when its member state is unknown', async () => {
    const unknownModel = structuredClone(model) as RoutingContextReadModelV1;
    if (unknownModel.resolution.state !== 'fresh') throw new Error('expected fresh fixture');
    unknownModel.resolution.snapshot.candidates[0].availability = 'unknown';
    unknownModel.resolution.snapshot.candidates[0].effect = 'advisory';
    mocks.useRoutingContext.mockReturnValue({
      data: unknownModel,
      loading: false,
      error: null,
      refresh: mocks.refresh,
    });
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));

    const provider = container.querySelector('[data-testid="team-provider-openai"]');
    expect(provider?.textContent).toContain('状态未知');
    expect(provider?.textContent).not.toContain('运行中');
  });

  it('offers a direct re-read and catalog names on the degraded page', async () => {
    const degradedModel = {
      ...model,
      resolution: {
        state: 'degraded',
        reason: 'built_in_profile_missing',
        affectedCatIds: ['codex-sol', 'glm52'],
        candidateBindings: [
          { v: 1, catId: 'codex-sol', providerId: 'openai', provenQuotaPools: [] },
          { v: 1, catId: 'glm52', providerId: 'zhipu', provenQuotaPools: [] },
        ],
      },
    } as RoutingContextReadModelV1;
    mocks.useRoutingContext.mockReturnValue({
      data: degradedModel,
      loading: false,
      error: null,
      refresh: mocks.refresh,
    });
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));

    const notice = container.querySelector('[data-testid="team-degraded-notice"]');
    // A known member is still a person here, not a machine id.
    expect(notice?.textContent).toContain('小太阳·砚砚');
    expect(notice?.textContent).not.toContain('codex-sol');
    // An unknown member honestly keeps its stable id.
    expect(notice?.textContent).toContain('glm52');

    const retry = container.querySelector<HTMLButtonElement>('[data-testid="team-degraded-retry"]');
    expect(retry).not.toBeNull();
    act(() => retry?.click());
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('keeps the canonical Team roster navigable when routing resolution is degraded', async () => {
    const degradedModel = {
      ...model,
      resolution: {
        state: 'degraded',
        reason: 'built_in_profile_missing',
        affectedCatIds: ['glm52'],
        candidateBindings: [
          { v: 1, catId: 'codex-sol', providerId: 'openai', provenQuotaPools: [] },
          { v: 1, catId: 'glm52', providerId: 'zhipu', provenQuotaPools: [] },
        ],
      },
    } as RoutingContextReadModelV1;
    mocks.useRoutingContext.mockReturnValue({
      data: degradedModel,
      loading: false,
      error: null,
      refresh: mocks.refresh,
    });
    const onSubjectChange = vi.fn();
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={onSubjectChange} />));

    expect(container.textContent).toContain('当前路由事实暂时不可完整读取');
    // A degraded routing read loses availability, not identity.
    expect(container.textContent).toContain('小太阳·砚砚');
    expect(container.textContent).toContain('glm52');
    const card = container.querySelector<HTMLButtonElement>('[data-testid="team-cat-codex-sol"]');
    expect(card).not.toBeNull();
    act(() => card?.click());
    expect(onSubjectChange).toHaveBeenCalledWith({ type: 'cat', id: 'codex-sol' });
  });
});
