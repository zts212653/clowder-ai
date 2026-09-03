import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  useRoutingContext: vi.fn(),
}));

vi.mock('../useRoutingContext', () => ({
  useRoutingContext: () => mocks.useRoutingContext(),
}));

const model = {
  v: 1,
  ownerId: 'owner-1',
  observedAt: 1_800_000_000_000,
  catalogRevision: 'catalog:1',
  resolution: {
    state: 'fresh',
    inputRevisionRef: 'routing:1',
    sourceRefs: { signalEventIds: ['signal-1'], preferenceRevisionIds: [], dossierRevisions: ['dossier:1'] },
    snapshot: {
      v: 1,
      ownerId: 'owner-1',
      observedAt: 1_800_000_000_000,
      catalogRevision: 'catalog:1',
      candidates: [
        {
          binding: { v: 1, catId: 'codex-sol', providerId: 'openai', provenQuotaPools: [] },
          profile: {
            state: 'applied',
            revision: {
              v: 1,
              catId: 'codex-sol',
              modelId: 'gpt-5.6-sol',
              dossierRevision: 'dossier:codex-sol:7',
              updatedAt: 1_799_999_000_000,
              relevantSignals: [{ kind: 'strength', summary: '复杂系统攻坚', evidenceRefs: ['evidence:strength'] }],
              pendingProposalCount: 1,
            },
          },
          availability: 'scarce',
          freshness: 'fresh',
          reasons: [{ code: 'manual-limit', summary: '本周额度需要节制', sourceRefs: ['signal-1'] }],
          matchedPreferences: [],
          effect: 'advisory',
        },
      ],
    },
  },
  signalEvents: [],
  preferenceRevisions: [],
} satisfies RoutingContextReadModelV1;

describe('F293 TeamWorkspacePanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.refresh.mockReset();
    mocks.useRoutingContext.mockReturnValue({ data: model, loading: false, error: null, refresh: mocks.refresh });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders canonical availability and F208 profile basis in the Team list', async () => {
    const { TeamWorkspacePanel } = await import('../TeamWorkspacePanel');
    await act(async () => root.render(<TeamWorkspacePanel subject={null} onSubjectChange={vi.fn()} />));

    expect(container.textContent).toContain('codex-sol');
    expect(container.textContent).toContain('需节制');
    expect(container.textContent).toContain('复杂系统攻坚');
    expect(container.querySelector('[data-team-layout="container-driven"]')).not.toBeNull();
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
    expect(container.textContent).toContain('codex-sol');
    const card = container.querySelector<HTMLButtonElement>('[data-testid="team-cat-codex-sol"]');
    expect(card).not.toBeNull();
    act(() => card?.click());
    expect(onSubjectChange).toHaveBeenCalledWith({ type: 'cat', id: 'codex-sol' });
  });
});
