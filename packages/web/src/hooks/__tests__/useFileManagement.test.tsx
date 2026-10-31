import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useFileManagement } from '../useFileManagement';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/components/useConfirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

let actions: ReturnType<typeof useFileManagement> | null = null;

function Harness({ ownerWorktreeId }: { ownerWorktreeId: string }) {
  actions = useFileManagement(ownerWorktreeId);
  return null;
}

describe('useFileManagement owner binding', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    actions = null;
    mocks.apiFetch.mockReset().mockImplementation(async (url: string) => {
      if (url === '/api/workspace/edit-session') {
        return {
          ok: true,
          json: async () => ({ token: 'owner-token', expiresIn: 60 }),
        };
      }
      if (url === '/api/workspace/file/create') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      throw new Error(`Unexpected API call: ${url}`);
    });
    useChatStore.setState({
      workspaceWorktreeId: 'ambient-worktree',
      workspaceEditToken: 'ambient-token',
      workspaceEditTokenExpiry: Date.now() + 60_000,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('mints and reuses a token scoped to the persisted owner instead of the ambient worktree', async () => {
    await act(async () => root.render(<Harness ownerWorktreeId="worktree-owner" />));

    await act(async () => {
      await actions?.createFile('src/first.ts');
      await actions?.createFile('src/second.ts');
    });

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/workspace/edit-session',
      expect.objectContaining({
        body: JSON.stringify({ worktreeId: 'worktree-owner' }),
      }),
    );
    expect(mocks.apiFetch.mock.calls.filter(([url]) => url === '/api/workspace/edit-session')).toHaveLength(1);
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/workspace/file/create',
      expect.objectContaining({
        body: JSON.stringify({
          worktreeId: 'worktree-owner',
          path: 'src/second.ts',
          content: '',
          editSessionToken: 'owner-token',
        }),
      }),
    );
    expect(useChatStore.getState().workspaceEditToken).toBe('ambient-token');
  });
});
