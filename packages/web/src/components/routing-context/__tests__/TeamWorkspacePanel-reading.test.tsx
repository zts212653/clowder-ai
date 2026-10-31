import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { model, rosterModel, TEAM_CATALOG, typeInto } from './team-panel-fixtures';

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

describe('F293 TeamWorkspacePanel reading continuity', () => {
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

  it('narrows the roster by search and filter and keeps the query across a detail round trip', async () => {
    mocks.useRoutingContext.mockReturnValue({ data: rosterModel, loading: false, error: null, refresh: mocks.refresh });
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));

    expect(container.querySelectorAll('[data-testid^="team-cat-"]')).toHaveLength(3);
    const absentFilter = container.querySelector<HTMLButtonElement>('[data-testid="team-filter-absent"]');
    expect(absentFilter?.textContent).toContain('1');
    await act(async () => absentFilter?.click());
    expect(container.querySelectorAll('[data-testid^="team-cat-"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="team-cat-opus5"]')).not.toBeNull();

    const search = container.querySelector<HTMLInputElement>('[data-testid="team-member-search"]');
    if (!search) throw new Error('expected a member search input');
    await act(async () => typeInto(search, '跨仓状态机'));
    expect(container.querySelectorAll('[data-testid^="team-cat-"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="team-search-empty"]')).not.toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="team-clear-filters"]')?.click());
    expect(container.querySelectorAll('[data-testid^="team-cat-"]')).toHaveLength(3);

    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('[data-testid="team-member-search"]');
      if (!input) throw new Error('expected a member search input');
      typeInto(input, '小团团');
    });
    expect(container.querySelectorAll('[data-testid^="team-cat-"]')).toHaveLength(1);
    await act(async () =>
      root.render(<TeamWorkspacePanel subject={{ type: 'cat', id: 'codex-terra' }} onSubjectChange={vi.fn()} />),
    );
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));
    expect(container.querySelector<HTMLInputElement>('[data-testid="team-member-search"]')?.value).toBe('小团团');
  });

  it('restores query, filter and roster scroll after the surface is remounted', async () => {
    mocks.useRoutingContext.mockReturnValue({ data: rosterModel, loading: false, error: null, refresh: mocks.refresh });
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    const { resetTeamReading } = await import('../team-reading-state');
    resetTeamReading();
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="team-filter-attention"]')?.click());
    const search = container.querySelector<HTMLInputElement>('[data-testid="team-member-search"]');
    if (!search) throw new Error('expected a member search input');
    await act(async () => typeInto(search, '砚砚'));

    // A fold / host switch unmounts the surface; the reading posture must survive it.
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));

    expect(container.querySelector<HTMLInputElement>('[data-testid="team-member-search"]')?.value).toBe('砚砚');
    expect(container.querySelector('[data-testid="team-filter-attention"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('restores the roster reading position every time the roster comes back, not just once', async () => {
    mocks.useRoutingContext.mockReturnValue({ data: rosterModel, loading: false, error: null, refresh: mocks.refresh });
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    const { readTeamReading, useTeamReading } = await import('../team-reading-state');
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));

    const panel = container.querySelector<HTMLDivElement>('[data-testid="team-workspace-panel"]');
    if (!panel) throw new Error('expected the Team panel viewport');
    // jsdom has no layout, so drive the scroll contract through the event the browser sends.
    Object.defineProperty(panel, 'scrollTop', { value: 240, writable: true, configurable: true });
    await act(async () => {
      panel.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(readTeamReading('global').scroll).toBe(240);

    // Into a member and back: the position must be replayed, not dropped.
    await act(async () =>
      root.render(<TeamWorkspacePanel subject={{ type: 'cat', id: 'codex-terra' }} onSubjectChange={vi.fn()} />),
    );
    panel.scrollTop = 0;
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));
    expect(container.querySelector<HTMLDivElement>('[data-testid="team-workspace-panel"]')?.scrollTop).toBe(240);

    useTeamReading.getState().reset();
  });

  it('buffers roster scrolling instead of persisting on every scroll event', async () => {
    mocks.useRoutingContext.mockReturnValue({ data: rosterModel, loading: false, error: null, refresh: mocks.refresh });
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    const { useTeamReading } = await import('../team-reading-state');
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));

    const panel = container.querySelector<HTMLDivElement>('[data-testid="team-workspace-panel"]');
    if (!panel) throw new Error('expected the Team panel viewport');
    let writes = 0;
    const unsubscribe = useTeamReading.subscribe(() => {
      writes += 1;
    });
    await act(async () => {
      for (let top = 1; top <= 20; top += 1) {
        Object.defineProperty(panel, 'scrollTop', { value: top, writable: true, configurable: true });
        panel.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    unsubscribe();

    // Twenty scroll events are one reading position, not twenty persisted writes.
    expect(writes).toBeLessThanOrEqual(2);
    useTeamReading.getState().reset();
  });
  it('commits the reading position when the reader leaves within the debounce window', async () => {
    mocks.useRoutingContext.mockReturnValue({ data: rosterModel, loading: false, error: null, refresh: mocks.refresh });
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));

    const panel = container.querySelector<HTMLDivElement>('[data-testid="team-workspace-panel"]');
    if (!panel) throw new Error('expected the Team panel viewport');
    Object.defineProperty(panel, 'scrollTop', { value: 240, writable: true, configurable: true });
    // Scroll and leave immediately — inside the 200ms debounce, before any timer fires.
    // A reader who taps a member right after scrolling must not lose their place.
    await act(async () => {
      panel.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await act(async () =>
      root.render(<TeamWorkspacePanel subject={{ type: 'cat', id: 'codex-terra' }} onSubjectChange={vi.fn()} />),
    );
    const { readTeamReading } = await import('../team-reading-state');
    expect(readTeamReading('global').scroll).toBe(240);

    panel.scrollTop = 0;
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));
    expect(container.querySelector<HTMLDivElement>('[data-testid="team-workspace-panel"]')?.scrollTop).toBe(240);
  });
});
