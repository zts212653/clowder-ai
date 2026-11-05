// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CollectiveClientRequestError } from '../client-request.js';
import type { SharedArtifact } from '../collective-artifact-client.js';
import { SharedArtifactManagement } from '../SharedArtifactManagement.js';
import { SharedArtifactReading } from '../SharedArtifactReading.js';
import { SharedArtifactSurface } from '../SharedArtifactSurface.js';
import { CollectiveArtifactContext, type CollectiveArtifactState } from '../use-collective-artifacts.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
it('manages the selected Artifact from its ordinary information panel and renders authority read back after an explicit Human action', async () => {
  const artifact = {
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    artifactId: 'artifact',
    mediaType: 'text/markdown',
    contentRef: 'content',
    sourceEventId: 'source',
    sourceLocation: { channelId: 'general' },
    versions: [{ ownerRevision: 1 }],
    availability: 'available',
    canManageAccess: true,
    canManageCustody: true,
  } as unknown as SharedArtifact;
  let access = 'read';
  let accessRevision = 1;
  const setAccess = vi.fn(async (_artifact, _human, value) => {
    access = value;
    ++accessRevision;
  });
  const management = {
    read: async () => ({
      ...artifact,
      canManageAccess: true,
      canManageCustody: true,
      custodyRevision: 1,
      custodianHumanId: 'owner',
      custodyAvailable: true,
      snapshot: 'snapshot',
      offset: 0,
      total: 1,
      members: [{ humanId: 'member', displayName: '另一位成员', access, accessRevision, canReceiveCustody: true }],
    }),
    setAccess,
    hasPending: () => false,
  };
  const state = {
    status: 'ready',
    selected: { artifactId: artifact.artifactId },
    catalogue: [artifact],
    humanId: 'owner',
    humanName: () => '发布者',
    refresh: async () => {},
    api: {
      management,
      read: async () => ({
        contentRef: 'content',
        ownerRevision: 1,
        blobDigest: 'digest',
        text: '共同正文',
        view: { canWrite: true, historyReadOnly: false, review: { revision: 1, annotations: [] } },
      }),
    },
  } as unknown as CollectiveArtifactState;
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <CollectiveArtifactContext.Provider value={state}>
          <SharedArtifactReading>
            <SharedArtifactSurface onReturnToSource={() => {}} onOpenDiscussion={() => {}} />
          </SharedArtifactReading>
        </CollectiveArtifactContext.Provider>,
      ),
    );
    const info = Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes('作品信息'));
    await act(async () => info?.click());
    expect(host.textContent).toContain('权限与保管');
    expect(host.querySelector('dialog[aria-label="作品信息"]')).not.toBeNull();
    const select = host.querySelector('select[aria-label="另一位成员的作品权限"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    await act(async () => {
      select.value = 'apply';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(setAccess).not.toHaveBeenCalled();
    const save = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === '更新另一位成员的权限',
    );
    await act(async () => save?.click());
    expect(setAccess).toHaveBeenCalledWith(artifact, 'member', 'apply', 1);
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="另一位成员的作品权限"]')?.value).toBe('apply');
    expect(host.textContent).toContain('保管作品');
    const closeInfo = host.querySelector<HTMLButtonElement>('button[aria-label="关闭作品信息"]');
    await act(async () => closeInfo?.click());
    expect(host.querySelector('dialog[aria-label="作品信息"]')).toBeNull();
    expect(host.textContent).toContain('共同正文');
  } finally {
    await act(async () => root.unmount());
  }
});

it('cannot disclose a late manager response after another Human takes over the same Artifact view', async () => {
  let resolveOld!: (value: unknown) => void;
  const artifact = {
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    artifactId: 'artifact',
    accessRevision: 1,
  } as SharedArtifact;
  const before = {
    status: 'ready',
    humanId: 'first-human',
    api: {
      management: {
        read: () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
        hasPending: () => false,
      },
    },
  } as unknown as CollectiveArtifactState;
  const after = {
    status: 'ready',
    humanId: 'other-human',
    api: {
      management: {
        read: async () => {
          throw new CollectiveClientRequestError(403, 'no manager authority');
        },
        hasPending: () => false,
      },
    },
  } as unknown as CollectiveArtifactState;
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (state: CollectiveArtifactState) =>
    root.render(
      <CollectiveArtifactContext.Provider value={state}>
        <SharedArtifactManagement artifact={artifact} />
      </CollectiveArtifactContext.Provider>,
    );
  try {
    await act(async () => render(before));
    await act(async () => render(after));
    await act(async () =>
      resolveOld({
        canManageAccess: true,
        members: [{ humanId: 'hidden', displayName: '旧身份专属权限表', access: 'apply', accessRevision: 1 }],
      }),
    );
    expect(host.textContent).toContain('你已无法管理这件作品');
    expect(host.textContent).not.toContain('旧身份专属权限表');
  } finally {
    await act(async () => root.unmount());
  }
});

it('keeps explicitly loaded manager pages across unchanged polling and discards them when the authoritative snapshot changes', async () => {
  vi.useFakeTimers();
  let snapshot = 'first-cut';
  const artifact = {
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    artifactId: 'artifact',
    accessRevision: 1,
  } as SharedArtifact;
  const firstMember = { humanId: 'first', displayName: '第一页成员', access: 'read', accessRevision: 1 };
  const secondMember = { humanId: 'second', displayName: '第二页成员', access: 'read', accessRevision: 1 };
  const state = {
    status: 'ready',
    humanId: 'manager',
    api: {
      management: {
        hasPending: () => false,
        read: async (_artifact: SharedArtifact, page?: { offset?: number }) => ({
          canManageAccess: true,
          canManageCustody: true,
          snapshot,
          total: 2,
          offset: page?.offset ?? 0,
          ...(page?.offset ? {} : { nextOffset: 1 }),
          members: page?.offset ? [secondMember] : [firstMember],
        }),
      },
    },
  } as unknown as CollectiveArtifactState;
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <CollectiveArtifactContext.Provider value={state}>
          <SharedArtifactManagement artifact={artifact} />
        </CollectiveArtifactContext.Provider>,
      ),
    );
    const more = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.startsWith('更多成员'),
    );
    await act(async () => more?.click());
    expect(host.textContent).toContain('第二页成员');
    await act(async () => vi.advanceTimersByTimeAsync(1800));
    expect(host.textContent).toContain('第二页成员');
    snapshot = 'new-policy-cut';
    await act(async () => vi.advanceTimersByTimeAsync(1800));
    expect(host.textContent).not.toContain('第二页成员');
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
