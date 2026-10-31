import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MemoryPage from '@/app/memory/page';
import { readProfileSourceTarget } from '../profile-source-target';

const fetchMock = vi.hoisted(() => vi.fn());
const shell = vi.hoisted(() => ({ mode: 'v2' }));
vi.mock('@/utils/api-client', () => ({ apiFetch: fetchMock }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/shell/shell-presentation', () => ({ useShellPresentation: () => shell.mode }));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ nickname: '宪宪' }) }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span>头像</span> }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));

const revision = `sha256:${'a'.repeat(64)}`;
const entry = {
  id: 'primer:ragdoll',
  type: 'profile',
  layer: 'primer',
  relationshipKey: 'ragdoll',
  uri: 'cat-cafe-profile://relationship/current',
  title: '主人关系画像',
  status: 'active',
  revision,
  content: '正确的主人画像正文',
  proposals: [],
};
const ok = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  shell.mode = 'v2';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  fetchMock.mockImplementation((path: string) => {
    if (path === '/api/memory/profile') return ok({ readStatus: 'ready', entries: [entry] });
    if (path.includes('/source?')) return ok({ status: 'not_recorded', sources: [] });
    if (path.startsWith('/api/memory/profile/')) return ok(entry);
    if (path === '/api/memory/taste') return ok({ readStatus: 'ready', entries: [] });
    return ok({});
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});
async function open(sourceRevision = revision, memoryId = entry.id) {
  await act(async () =>
    root.render(
      <MemoryPage searchParams={{ family: 'profile', memoryId, revision: sourceRevision, from: 'original-thread' }} />,
    ),
  );
}

it('opens the source profile detail through the actual memory route and its owner reader', async () => {
  await open();
  expect(host.querySelector('aside[aria-label="画像详情"]')).not.toBeNull();
  expect(host.textContent).toContain(entry.content);
  expect(
    fetchMock.mock.calls.some(
      ([path]) => path === `/api/memory/profile/primer%3Aragdoll?revision=${encodeURIComponent(revision)}`,
    ),
  ).toBe(true);
  expect(host.querySelector('a[aria-label="返回原对话"]')?.getAttribute('href')).toBe('/thread/original-thread');
  expect(fetchMock.mock.calls.every((args) => args.length === 1)).toBe(true);
});

it('does not present a current replacement as the historical delivery when revisions differ', async () => {
  await open(`sha256:${'b'.repeat(64)}`);
  expect(host.textContent).toContain('来源版本已变化');
  expect(host.textContent).not.toContain(entry.content);
  expect(host.querySelector('aside[aria-label="画像详情"]')).toBeNull();
  expect(fetchMock.mock.calls.some(([path]) => path.startsWith('/api/memory/profile/'))).toBe(false);
});

it('keeps a forgotten source unavailable instead of silently showing the home study', async () => {
  fetchMock.mockImplementation((path: string) =>
    path === '/api/memory/profile' ? ok({ readStatus: 'ready', entries: [] }) : ok({}),
  );
  await open();
  expect(host.textContent).toContain('这条来源暂时读不到');
  expect(host.textContent).not.toContain('主星书房');
});

it('returns from a source detail to the current owner list without inventing a missing-source error', async () => {
  await open();
  const close = host.querySelector<HTMLButtonElement>('aside[aria-label="画像详情"] button');
  expect(close).not.toBeNull();
  await act(async () => close?.click());
  expect(host.querySelector('aside[aria-label="画像详情"]')).toBeNull();
  expect(host.querySelector('[aria-label="画像记忆"]')).not.toBeNull();
  expect(host.textContent).not.toContain('这条来源暂时读不到');
});

it('opens the same source with a classic shell preference without changing that preference', async () => {
  shell.mode = 'classic';
  await open();
  expect(host.querySelector('aside[aria-label="画像详情"]')).not.toBeNull();
  expect(host.textContent).toContain(entry.content);
  expect(shell.mode).toBe('classic');
});

it('rejects an incomplete or unimplemented source without reading an unrelated current profile', async () => {
  await open(revision, 'capsule:other');
  expect(host.textContent).toContain('来源链接不完整');
  expect(fetchMock.mock.calls.some(([path]) => path.startsWith('/api/memory/profile'))).toBe(false);
});

it('opens the current capsule through the same version-bound profile detail', async () => {
  const capsule = { ...entry, id: 'capsule', layer: 'capsule', relationshipKey: null, title: '开场胶囊' };
  fetchMock.mockImplementation((path: string) => {
    if (path === '/api/memory/profile') return ok({ readStatus: 'ready', entries: [capsule] });
    if (path.includes('/source?')) return ok({ status: 'not_recorded', sources: [] });
    if (path.startsWith('/api/memory/profile/')) return ok(capsule);
    return ok({});
  });
  await open(revision, 'capsule');
  expect(host.querySelector('aside[aria-label="画像详情"]')).not.toBeNull();
  expect(host.textContent).toContain(capsule.content);
  expect(
    fetchMock.mock.calls.some(
      ([path]) => path === `/api/memory/profile/capsule?revision=${encodeURIComponent(revision)}`,
    ),
  ).toBe(true);
});

it('accepts canonical dotted relationship keys and rejects path segments outside the existing owner contract', () => {
  expect(readProfileSourceTarget({ family: 'profile', memoryId: 'primer:family.v2', revision })).toEqual({
    status: 'ready',
    id: 'primer:family.v2',
    revision,
  });
  for (const id of ['primer:../private', 'primer:', 'primer:ragdoll/other', 'corpus:other'])
    expect(readProfileSourceTarget({ family: 'profile', memoryId: id, revision })).toEqual({ status: 'invalid' });
  expect(readProfileSourceTarget({ family: 'profile', memoryId: 'corpus' })).toEqual({ status: 'invalid' });
});
