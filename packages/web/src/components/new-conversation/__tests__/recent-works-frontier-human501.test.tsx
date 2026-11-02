import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recent: {
    artifacts: [] as unknown[],
    workLineage: 'resolved',
    loading: false,
    error: false,
    complete: false,
    refetch: vi.fn(),
  },
  all: {
    artifacts: [] as unknown[],
    workLineage: 'resolved',
    loading: false,
    loadingMore: false,
    error: false,
    complete: false,
    refetch: vi.fn(),
  },
}));
vi.mock('@/hooks/useGlobalArtifacts', () => ({
  useGlobalArtifacts: (_enabled: boolean, query: { view: string }) =>
    query.view === 'works' ? mocks.all : mocks.recent,
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => ({ id: 'codex61-sol', displayName: '砚砚' }) }),
}));
vi.mock('@/components/shell/ShellCatAvatar', () => ({ ShellCatAvatar: () => null }));

import { RecentWorks } from '@/components/new-conversation/RecentWorks';

const image = (name: string, time: number) => ({
  type: 'image',
  name,
  catId: 'codex61-sol',
  createdAt: time,
  sourceMessageId: name,
  url: `/uploads/${name}.png`,
  threadId: 'owned',
  threadTitle: 'Original',
});

it('keeps the recent first row until later catalogue pages prove their complete order', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.recent.artifacts = [image('current guide', 100)];
  mocks.all.artifacts = [image('six day old room', 1), image('six day old notebook', 1)];
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(<RecentWorks onOpen={() => {}} onOpenAll={() => {}} />));
    act(() => host.querySelector<HTMLButtonElement>('.work-gallery-more')?.click());
    expect([...host.querySelectorAll('.work-gallery-title')].map((item) => item.getAttribute('title'))).toEqual([
      'current guide',
    ]);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
