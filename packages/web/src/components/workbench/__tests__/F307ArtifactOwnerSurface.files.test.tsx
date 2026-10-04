import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { F307ArtifactOwnerSurface } from '../F307ArtifactOwnerSurface';
import {
  artifactObjectId,
  createArtifactSurface,
  createFileSurface,
  resolveFileTarget,
} from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-model';

const fixture = vi.hoisted(() => ({ artifacts: [] as ThreadArtifactDTO[], fetch: vi.fn() }));
vi.mock('@/hooks/useThreadArtifacts', () => ({
  useThreadArtifacts: () => ({ artifacts: fixture.artifacts, loading: false, error: false }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fixture.fetch(...args) }));
vi.mock('@/components/artifacts/ArtifactDetailView', () => ({
  ArtifactDetailView: () => <div data-testid="weak-preview" />,
}));
vi.mock('../ArtifactPublicationSurface', () => ({ ArtifactPublicationSurface: () => <div /> }));
const container = document.createElement('div');
const root = createRoot(container);
const original = useF307ExperienceWorkbenchStore.getState();
it('keeps an unverifiable location visible and disabled instead of treating its survivor as the original', async () => {
  const artifact: ThreadArtifactDTO = {
    type: 'file',
    name: 'notes.txt',
    ref: 'notes.txt',
    catId: null,
    createdAt: 16,
    sourceMessageId: null,
  };
  fixture.artifacts = [artifact];
  const surface = createArtifactSurface({ threadId: 'original-thread', artifact });
  fixture.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      ownerUserId: 'operator',
      inventory: 'partial',
      locations: [
        { root: '/A', label: 'A', branch: 'original', status: 'unavailable' },
        { root: '/B', label: 'B', branch: 'remaining', status: 'available' },
      ],
    }),
  });
  await act(async () =>
    root.render(
      <F307ArtifactOwnerSurface surface={surface} onRequestDetach={() => undefined} onOpenSurface={() => undefined} />,
    ),
  );
  const unavailable = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('在 A 继续'),
  );
  expect(unavailable?.disabled).toBe(true);
  expect(container.textContent).toContain('暂时无法核验');
  expect(fixture.fetch.mock.calls.every(([url]) => url.endsWith('file-locations'))).toBe(true);
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
});
afterEach(() => {
  act(() => root.render(null));
  useF307ExperienceWorkbenchStore.setState(original, true);
  fixture.fetch.mockReset();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('a storage failure leaves the previous location intact and visibly reports that the new choice was not saved', async () => {
  const artifact: ThreadArtifactDTO = {
    type: 'code',
    name: 'quota.ts',
    ref: 'quota.ts',
    catId: 'opus5',
    createdAt: 12,
    sourceMessageId: null,
  };
  fixture.artifacts = [artifact];
  const surface = createArtifactSurface({ threadId: 'original-thread', artifact });
  const key = `cat-cafe:artifact-file-location:${JSON.stringify(['operator', 'original-thread', artifactObjectId(artifact)])}`;
  const prior = JSON.stringify({ absolutePath: '/A/quota.ts', label: 'A' });
  localStorage.setItem(key, prior);
  fixture.fetch.mockImplementation(async (url: string, init?: RequestInit) =>
    url.endsWith('file-locations')
      ? {
          ok: true,
          json: async () => ({
            ownerUserId: 'operator',
            inventory: 'available',
            locations: [{ root: '/B', label: 'B', branch: 'branch', status: 'available' }],
          }),
        }
      : JSON.parse(String(init?.body)).selectedRoot
        ? {
            ok: true,
            json: async () => ({ worktreeId: 'B', path: 'quota.ts', kind: 'file', absolutePath: '/B/quota.ts' }),
          }
        : { ok: false, status: 404, json: async () => ({}) },
  );
  const layout = createInitialWorkbenchState([surface]);
  useF307ExperienceWorkbenchStore.setState({ layout });
  await act(async () =>
    root.render(
      <F307ArtifactOwnerSurface surface={surface} onRequestDetach={() => undefined} onOpenSurface={() => undefined} />,
    ),
  );
  act(() =>
    [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('选择其他位置'))!.click(),
  );
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError');
  });
  try {
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('在 B 继续'))!.click(),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('尚未保存');
    expect(localStorage.getItem(key)).toBe(prior);
    expect(useF307ExperienceWorkbenchStore.getState().layout).toBe(layout);
  } finally {
    save.mockRestore();
  }
});

it('a saved inaccessible A stays selected when only B is listed, and never overwrites the saved choice', async () => {
  const artifact: ThreadArtifactDTO = {
    type: 'file',
    name: 'notes.txt',
    ref: 'notes.txt',
    catId: 'opus5',
    createdAt: 10,
    sourceMessageId: null,
  };
  fixture.artifacts = [artifact];
  const surface = createArtifactSurface({ threadId: 'original-thread', artifact });
  const key = `cat-cafe:artifact-file-location:${JSON.stringify(['operator', 'original-thread', artifactObjectId(artifact)])}`;
  const saved = JSON.stringify({ absolutePath: '/A/notes.txt', label: 'A' });
  localStorage.setItem(key, saved);
  fixture.fetch.mockImplementation(async (url: string) =>
    url.endsWith('file-locations')
      ? {
          ok: true,
          json: async () => ({
            ownerUserId: 'operator',
            inventory: 'partial',
            locations: [{ root: '/B', label: 'B', branch: 'only remaining', status: 'available' }],
          }),
        }
      : { ok: false, status: 403, json: async () => ({}) },
  );
  await act(async () =>
    root.render(
      <F307ArtifactOwnerSurface surface={surface} onRequestDetach={() => undefined} onOpenSurface={() => undefined} />,
    ),
  );
  expect(container.textContent).toContain('继续你选定的位置：A');
  expect(container.querySelector('[role="alert"]')).toBeTruthy();
  expect(
    fixture.fetch.mock.calls
      .filter(([url]) => url.endsWith('resolve-file-source'))
      .map(([, init]) => JSON.parse(init.body)),
  ).toEqual([{ path: '/A/notes.txt' }]);
  expect(localStorage.getItem(key)).toBe(saved);
  act(() =>
    [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('选择其他位置'))!.click(),
  );
  expect(container.textContent).toContain('部分已登记位置');
  expect(container.textContent).toContain('在 B 继续');
  expect(localStorage.getItem(key)).toBe(saved);
});

it('a late response after the entrance closes cannot save a choice or navigate', async () => {
  const artifact: ThreadArtifactDTO = {
    type: 'code',
    name: 'late.ts',
    ref: 'late.ts',
    catId: 'opus5',
    createdAt: 11,
    sourceMessageId: null,
  };
  fixture.artifacts = [artifact];
  const surface = createArtifactSurface({ threadId: 'source', artifact });
  const layout = createInitialWorkbenchState([surface]);
  useF307ExperienceWorkbenchStore.setState({ layout });
  let finish: ((value: unknown) => void) | undefined;
  fixture.fetch.mockImplementation(async (url: string) =>
    url.endsWith('file-locations')
      ? {
          ok: true,
          json: async () => ({
            ownerUserId: 'operator',
            inventory: 'available',
            locations: [{ root: '/B', label: 'B', branch: 'branch', status: 'available' }],
          }),
        }
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  await act(async () =>
    root.render(
      <F307ArtifactOwnerSurface surface={surface} onRequestDetach={() => undefined} onOpenSurface={() => undefined} />,
    ),
  );
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('在 B 继续'))!.click(),
  );
  act(() => root.render(null));
  await act(async () =>
    finish!({
      ok: true,
      json: async () => ({ worktreeId: 'B', path: 'late.ts', kind: 'file', absolutePath: '/B/late.ts' }),
    }),
  );
  expect(useF307ExperienceWorkbenchStore.getState().layout).toBe(layout);
  expect(
    localStorage.getItem(
      `cat-cafe:artifact-file-location:${JSON.stringify(['operator', 'source', artifactObjectId(artifact)])}`,
    ),
  ).toBeNull();
});

it('requires a named current location for a legacy relative record even when only B remains, then retains that exact choice', async () => {
  const artifact: ThreadArtifactDTO = {
    type: 'code',
    name: 'notes.txt',
    ref: 'notes.txt',
    catId: 'opus5',
    createdAt: 9,
    sourceMessageId: null,
  };
  fixture.artifacts = [artifact];
  const surface = createArtifactSurface({ threadId: 'original-source-thread', artifact });
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([surface]) });
  fixture.fetch.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith('file-locations')
        ? {
            ownerUserId: 'operator',
            inventory: 'available',
            locations: [{ root: '/B', label: 'B', branch: 'remaining', status: 'available' }],
          }
        : { worktreeId: 'B', path: 'notes.txt', kind: 'file', absolutePath: '/B/notes.txt' },
  }));
  await act(async () =>
    root.render(
      <F307ArtifactOwnerSurface surface={surface} onRequestDetach={() => undefined} onOpenSurface={() => undefined} />,
    ),
  );
  expect(fixture.fetch.mock.calls.every(([url]) => url.endsWith('file-locations'))).toBe(true);
  expect(container.textContent).toContain('没有保存原目录');
  expect(container.querySelector('[data-testid="weak-preview"]')).toBeNull();
  const choose = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('在 B 继续'));
  expect(choose).toBeDefined();
  await act(async () => choose!.click());
  expect(fixture.fetch).toHaveBeenCalledWith(
    '/api/workspace/resolve-file-source',
    expect.objectContaining({
      body: JSON.stringify({ selectedRoot: '/B', path: 'notes.txt', expectedUserId: 'operator' }),
    }),
  );
  expect(resolveFileTarget(useF307ExperienceWorkbenchStore.getState().layout.surfaces[0]!)).toEqual({
    worktreeId: 'B',
    path: 'notes.txt',
    scrollToLine: null,
  });
  const key = `cat-cafe:artifact-file-location:${JSON.stringify(['operator', 'original-source-thread', artifactObjectId(artifact)])}`;
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ absolutePath: '/B/notes.txt', label: 'B' });
  act(() => root.render(null));
  fixture.fetch.mockClear();
  await act(async () =>
    root.render(
      <F307ArtifactOwnerSurface surface={surface} onRequestDetach={() => undefined} onOpenSurface={() => undefined} />,
    ),
  );
  expect(fixture.fetch).toHaveBeenCalledWith(
    '/api/workspace/resolve-file-source',
    expect.objectContaining({ body: JSON.stringify({ path: '/B/notes.txt' }) }),
  );
});

it.each([
  'code.ts',
  'proposal.docx',
])('opens %s by its original absolute locator rather than the current Workspace', async (name) => {
  const artifact: ThreadArtifactDTO = {
    type: 'file',
    name,
    ref: `/original/${name}`,
    catId: 'opus5',
    createdAt: 7,
    sourceMessageId: null,
  };
  fixture.artifacts = [artifact];
  const surface = createArtifactSurface({ threadId: 'source-thread', artifact });
  useChatStore.setState({ currentThreadId: 'other-thread', workspaceWorktreeId: 'wrong-current' });
  const file = createFileSurface({ worktreeId: 'original-worktree', path: name });
  useF307ExperienceWorkbenchStore.setState({
    layout: { ...createInitialWorkbenchState([file, surface]), activeSurfaceId: surface.id },
  });
  fixture.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ worktreeId: 'original-worktree', path: name, kind: 'file' }),
  });
  await act(async () =>
    root.render(
      <F307ArtifactOwnerSurface surface={surface} onRequestDetach={() => undefined} onOpenSurface={() => undefined} />,
    ),
  );
  expect(fixture.fetch).toHaveBeenCalledWith(
    '/api/workspace/resolve-file-source',
    expect.objectContaining({ body: JSON.stringify({ path: `/original/${name}` }) }),
  );
  const layout = useF307ExperienceWorkbenchStore.getState().layout;
  expect(layout.surfaces).toHaveLength(1);
  expect(resolveFileTarget(layout.surfaces[0]!)).toEqual({
    worktreeId: 'original-worktree',
    path: name,
    scrollToLine: null,
  });
  expect(container.querySelector('[data-testid="weak-preview"]')).toBeNull();
});

it('shows an unavailable original with retry and return, never a guessed file preview', async () => {
  const artifact: ThreadArtifactDTO = {
    type: 'code',
    name: 'gone.ts',
    ref: '/removed/gone.ts',
    catId: 'opus5',
    createdAt: 8,
    sourceMessageId: null,
  };
  fixture.artifacts = [artifact];
  const surface = createArtifactSurface({ threadId: 'source-thread', artifact });
  const back = vi.fn();
  fixture.fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
  await act(async () =>
    root.render(<F307ArtifactOwnerSurface surface={surface} onRequestDetach={back} onOpenSurface={() => undefined} />),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('原位置');
  expect(container.querySelector('[data-testid="weak-preview"]')).toBeNull();
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons.some((button) => button.textContent?.includes('重试'))).toBe(true);
  act(() => buttons.find((button) => button.textContent?.includes('返回'))!.click());
  expect(back).toHaveBeenCalledOnce();
});
