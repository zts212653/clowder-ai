import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useFileEditing } from '../useFileEditing';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));

let editing: ReturnType<typeof useFileEditing> | null = null;
const fetchFile = vi.fn();

function Harness() {
  editing = useFileEditing({
    worktreeId: 'worktree-owner',
    openFilePath: 'src/owner.ts',
    file: { sha256: 'sha-owner', binary: false, truncated: false },
    fetchFile,
  });
  return null;
}

describe('useFileEditing owner binding', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    editing = null;
    fetchFile.mockReset().mockResolvedValue(undefined);
    mocks.apiFetch.mockReset().mockImplementation(async (url: string) => {
      if (url === '/api/workspace/edit-session') {
        return { ok: true, json: async () => ({ token: 'owner-token', expiresIn: 60 }) };
      }
      if (url === '/api/workspace/file') {
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

  it('mints and saves with the explicit file owner token instead of an ambient token', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await editing?.handleToggleEdit();
    });
    await act(async () => {
      await editing?.handleSave('owner content');
    });

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/workspace/edit-session',
      expect.objectContaining({ body: JSON.stringify({ worktreeId: 'worktree-owner' }) }),
    );
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/workspace/file',
      expect.objectContaining({
        body: JSON.stringify({
          worktreeId: 'worktree-owner',
          path: 'src/owner.ts',
          content: 'owner content',
          baseSha256: 'sha-owner',
          editSessionToken: 'owner-token',
        }),
      }),
    );
    expect(useChatStore.getState().workspaceEditToken).toBe('ambient-token');
  });
  it('uses the draft base for CAS and returns only an actual matching file receipt', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await editing?.handleToggleEdit();
    });
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ path: 'src/owner.ts', sha256: 'b'.repeat(64) }),
    });
    let receipt: unknown;
    await act(async () => {
      receipt = await editing?.handleSave('draft text', { baseSha256: 'a'.repeat(64) });
    });
    const payload = JSON.parse(mocks.apiFetch.mock.calls.at(-1)![1].body);
    expect(payload.baseSha256).toBe('a'.repeat(64));
    expect(receipt).toEqual({ path: 'src/owner.ts', sha256: 'b'.repeat(64) });
    expect(fetchFile).toHaveBeenCalledWith('src/owner.ts');
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ path: 'other.ts', sha256: 'c'.repeat(64) }),
    });
    await act(async () => {
      receipt = await editing?.handleSave('another edit', { baseSha256: 'b'.repeat(64) });
    });
    expect(receipt).toBeUndefined();
    expect(editing?.saveError).toContain('回执尚未核验');
  });
});
