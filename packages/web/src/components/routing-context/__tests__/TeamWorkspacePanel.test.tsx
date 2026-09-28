import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { model, rosterModel, TEAM_CATALOG } from './team-panel-fixtures';

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

describe('F293 TeamWorkspacePanel presentation', () => {
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

  it('leads with catalog identity and a readable capability line instead of routing field stacks', async () => {
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));

    const row = container.querySelector('[data-testid="team-cat-codex-sol"]');
    expect(row?.textContent).toContain('小太阳·砚砚');
    expect(row?.textContent).toContain('缅因猫 Sol · gpt-5.6-sol');
    expect(row?.textContent).toContain('复杂系统攻坚');
    expect(row?.textContent).toContain('供给偏紧');
    expect(row?.querySelector('img')?.getAttribute('src')).toBe('/avatars/codex-sol.png');
    // The stable id and the dossier hash stay out of the roster body (AC-UX1).
    expect(row?.textContent).not.toContain('codex-sol');
    expect(row?.textContent).not.toContain('dossier:codex-sol:7');
    expect(container.querySelector('[data-team-layout="container-driven"]')).not.toBeNull();
  });

  it('keeps the preference editor behind an on-demand entry rather than ahead of the members', async () => {
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));

    expect(container.querySelector('[data-testid="routing-preference-controls"]')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="team-preferences-toggle"]');
    expect(toggle).not.toBeNull();
    const roster = container.querySelector('[data-testid="team-members-section"]');
    expect(roster).not.toBeNull();
    await act(async () => toggle?.click());
    const controls = container.querySelector('[data-testid="routing-preference-controls"]');
    expect(controls).not.toBeNull();
    // Reading existing rules comes first; the create form only opens on request (AC-UX3).
    expect(controls?.querySelector('form')).toBeNull();
  });

  it('layers member detail into fit, watch-out and a folded evidence section', async () => {
    mocks.useRoutingContext.mockReturnValue({ data: rosterModel, loading: false, error: null, refresh: mocks.refresh });
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () =>
      root.render(<TeamWorkspacePanel subject={{ type: 'cat', id: 'codex-terra' }} onSubjectChange={vi.fn()} />),
    );

    expect(container.textContent).toContain('小团团·砚砚');
    const fit = container.querySelector('[data-testid="team-detail-fit"]');
    const cautions = container.querySelector('[data-testid="team-detail-cautions"]');
    expect(fit?.textContent).toContain('跨仓状态机');
    expect(cautions?.textContent).toContain('只有几行机械修改时不值得请他');
    expect(fit?.textContent).not.toContain('只有几行机械修改时不值得请他');

    const evidence = container.querySelector<HTMLDetailsElement>('[data-testid="team-detail-evidence"]');
    expect(evidence).not.toBeNull();
    expect(evidence?.open).toBe(false);
    expect(evidence?.textContent).toContain('dossier:codex-terra:2');
    expect(evidence?.textContent).toContain('codex-terra');
    expect(evidence?.textContent).toContain('evidence:terra-fit');
    // Hashes and refs must not leak above the fold.
    const aboveFold = container.textContent?.replace(evidence?.textContent ?? '', '') ?? '';
    expect(aboveFold).not.toContain('dossier:codex-terra:2');
  });

  it('states a missing capability profile honestly and still opens the member detail', async () => {
    mocks.useRoutingContext.mockReturnValue({ data: rosterModel, loading: false, error: null, refresh: mocks.refresh });
    const onSubjectChange = vi.fn();
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={onSubjectChange} />));

    const row = container.querySelector<HTMLButtonElement>('[data-testid="team-cat-opus5"]');
    expect(row?.textContent).toContain('能力资料待补充');
    expect(row?.textContent).toContain('状态待确认');
    await act(async () => row?.click());
    expect(onSubjectChange).toHaveBeenCalledWith({ type: 'cat', id: 'opus5' });

    await act(async () =>
      root.render(<TeamWorkspacePanel subject={{ type: 'cat', id: 'opus5' }} onSubjectChange={onSubjectChange} />),
    );
    expect(container.textContent).toContain('能力资料待补充');
    expect(container.textContent).toContain('也不代表不可用');
    expect(container.querySelector('[data-testid="team-detail-fit"]')).toBeNull();
  });

  it('separates an unknown profile date from having no applied profile at all', async () => {
    const undatedModel = structuredClone(rosterModel) as RoutingContextReadModelV1;
    if (undatedModel.resolution.state !== 'fresh') throw new Error('expected fresh fixture');
    const terra = undatedModel.resolution.snapshot.candidates[1];
    if (terra.profile.state !== 'applied') throw new Error('expected an applied profile');
    // DossierCapabilityProfileRevisionSource legitimately reports 0 for an unknown
    // provenance date; that is not the same as having no applied revision.
    terra.profile.revision.updatedAt = 0;
    mocks.useRoutingContext.mockReturnValue({
      data: undatedModel,
      loading: false,
      error: null,
      refresh: mocks.refresh,
    });
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () =>
      root.render(<TeamWorkspacePanel subject={{ type: 'cat', id: 'codex-terra' }} onSubjectChange={vi.fn()} />),
    );

    expect(container.textContent).toContain('这一版画像没有记录依据日期');
    expect(container.textContent).not.toContain('暂无已应用的画像版本');
    expect(container.querySelector('[data-testid="team-detail-fit"]')).not.toBeNull();
  });

  it('reads a trusted human attempt as still possible when dispatch allows it', async () => {
    const blockedModel = structuredClone(rosterModel) as RoutingContextReadModelV1;
    if (blockedModel.resolution.state !== 'fresh') throw new Error('expected fresh fixture');
    const sol = blockedModel.resolution.snapshot.candidates[0];
    sol.availability = 'unavailable';
    sol.effect = 'blocked';
    sol.dispatch = { ownerAttemptAllowed: true };
    mocks.useRoutingContext.mockReturnValue({
      data: blockedModel,
      loading: false,
      error: null,
      refresh: mocks.refresh,
    });
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () =>
      root.render(<TeamWorkspacePanel subject={{ type: 'cat', id: 'codex-sol' }} onSubjectChange={vi.fn()} />),
    );

    expect(container.textContent).toContain('你仍然可以');
    expect(container.textContent).not.toContain('现在发送会被拒绝');
  });

  it('counts collaboration preferences as rules, not as stored revisions', async () => {
    const versionedModel = structuredClone(model) as RoutingContextReadModelV1;
    const base = {
      v: 1 as const,
      preferenceId: 'preference-1',
      ownerId: 'owner-1',
      appliesWhen: { intent: 'review' as const },
      prefer: [{ type: 'cat' as const, catId: 'codex-terra' }],
      over: [{ type: 'cat' as const, catId: 'codex-sol' }],
      rationale: '复杂终审优先找 Terra',
      evidenceRefs: ['decision:F293'],
      lifecycle: 'active' as const,
    };
    versionedModel.preferenceRevisions = [
      { ...base, revisionId: 'rev-1', commandId: 'command-1', version: 1, validFrom: 1_799_000_000_000 },
      {
        ...base,
        revisionId: 'rev-2',
        commandId: 'command-2',
        version: 2,
        validFrom: 1_799_000_001_000,
        supersedesRevisionId: 'rev-1',
      },
      {
        ...base,
        revisionId: 'rev-3',
        commandId: 'command-3',
        version: 3,
        validFrom: 1_799_000_002_000,
        supersedesRevisionId: 'rev-2',
      },
    ] satisfies RoutingContextReadModelV1['preferenceRevisions'];
    mocks.useRoutingContext.mockReturnValue({
      data: versionedModel,
      loading: false,
      error: null,
      refresh: mocks.refresh,
    });
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));

    const toggle = container.querySelector('[data-testid="team-preferences-toggle"]');
    expect(toggle?.textContent).toContain('1');
    expect(toggle?.textContent).not.toContain('3');
  });

  it('uses internal back to return from detail to the Team list', async () => {
    const onSubjectChange = vi.fn();
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () =>
      root.render(<TeamWorkspacePanel subject={{ type: 'cat', id: 'codex-sol' }} onSubjectChange={onSubjectChange} />),
    );

    expect(container.textContent).toContain('本周额度需要节制');
    expect(container.querySelector<HTMLAnchorElement>('[data-testid="team-open-dossier-source"]')?.href).toContain(
      '/settings?s=profiles',
    );
    const back = container.querySelector<HTMLButtonElement>('[data-testid="team-detail-back"]');
    expect(back).not.toBeNull();
    act(() => back?.click());
    expect(onSubjectChange).toHaveBeenCalledWith(null);
  });
});
