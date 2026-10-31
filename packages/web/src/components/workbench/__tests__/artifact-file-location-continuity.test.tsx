import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { F307ArtifactOwnerSurface } from '../F307ArtifactOwnerSurface';
import { createArtifactSurface } from '../real-surface-adapters';

const fixture = vi.hoisted(() => ({ artifacts: [] as ThreadArtifactDTO[], fetch: vi.fn() }));
vi.mock('@/hooks/useThreadArtifacts', () => ({ useThreadArtifacts: () => ({ artifacts: fixture.artifacts }) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fixture.fetch(...args) }));
vi.mock('@/components/artifacts/ArtifactDetailView', () => ({ ArtifactDetailView: () => null }));
vi.mock('../ArtifactPublicationSurface', () => ({ ArtifactPublicationSurface: () => null }));

it('retains an explicit ledger location through ordinary updates without lending it to a separate message item', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  localStorage.clear();
  fixture.fetch.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith('file-locations')
        ? {
            ownerUserId: 'operator',
            inventory: 'available',
            locations: [{ root: '/A', label: 'A', branch: 'main', status: 'available' }],
          }
        : { kind: 'file', worktreeId: 'A', path: 'notes.txt', absolutePath: '/A/notes.txt' },
  }));
  const artifact = {
    type: 'file' as const,
    name: 'notes.txt',
    ref: 'notes.txt',
    catId: 'opus5',
    createdAt: 1,
    sourceMessageId: null,
    fileLedgerRef: 'notes.txt',
  };
  async function open(item: ThreadArtifactDTO) {
    await act(async () => root.render(null));
    fixture.artifacts = [item];
    await act(async () =>
      root.render(
        <F307ArtifactOwnerSurface
          surface={createArtifactSurface({ threadId: 'source', artifact: item })}
          onRequestDetach={() => undefined}
          onOpenSurface={() => undefined}
        />,
      ),
    );
  }
  try {
    await open(artifact);
    await act(async () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === '在 A 继续')!.click(),
    );
    fixture.fetch.mockClear();
    await open({ ...artifact, createdAt: 2, catId: 'codex-astra', name: 'Updated notes' });
    expect(fixture.fetch).toHaveBeenCalledWith(
      '/api/workspace/resolve-file-source',
      expect.objectContaining({ body: JSON.stringify({ path: '/A/notes.txt' }) }),
    );
    fixture.fetch.mockClear();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- an item without its file ledger
    const { fileLedgerRef: _, ...messageItem } = artifact;
    await open({ ...messageItem, sourceMessageId: 'different-message' });
    expect(container.textContent).toContain('没有保存原目录');
    expect(fixture.fetch.mock.calls.every(([url]) => url.endsWith('file-locations'))).toBe(true);
  } finally {
    act(() => root.unmount());
    localStorage.clear();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
