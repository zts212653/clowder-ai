import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '../../shell/shell-language';

const mocks = vi.hoisted(() => ({
  result: {
    artifacts: [] as GlobalArtifactDTO[],
    workLineage: 'unavailable' as const,
    loading: false,
    error: false,
    complete: true,
    refetch: vi.fn(),
  },
  useGlobalArtifacts: vi.fn(),
  all: null as null | {
    artifacts: GlobalArtifactDTO[];
    workLineage: 'resolved' | 'unavailable';
    complete: boolean;
    loading: boolean;
    loadingMore?: boolean;
    error: boolean;
    refetch: () => void;
  },
}));

vi.mock('@/hooks/useGlobalArtifacts', () => ({
  useGlobalArtifacts: (...args: unknown[]) => {
    mocks.useGlobalArtifacts(...args);
    return (args[1] as { view?: string })?.view === 'works' && mocks.all ? mocks.all : mocks.result;
  },
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => ({ id: 'codex-sol', displayName: '砚砚' }) }),
}));
vi.mock('../../shell/ShellCatAvatar', () => ({
  knownCatName: () => '砚砚',
  ShellCatAvatar: () => <span data-testid="cat-avatar" />,
}));

import { RecentWorks } from '../RecentWorks';

function artifact(name: string, createdAt: number): GlobalArtifactDTO {
  return {
    type: 'image',
    name,
    catId: 'codex-sol',
    createdAt,
    sourceMessageId: `message-${name}`,
    url: `/uploads/${name}.png`,
    publicationItem: { kind: 'content-block', index: 0 },
    threadId: 'thread-a',
    threadTitle: 'Thread A',
  };
}

describe('RecentWorks bounded read states', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    writeShellLanguage('zh');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.useGlobalArtifacts.mockClear();
    mocks.all = null;
    mocks.result = {
      artifacts: [],
      workLineage: 'unavailable',
      loading: false,
      error: false,
      complete: true,
      refetch: vi.fn(),
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    writeShellLanguage('zh');
  });

  function render() {
    act(() => root.render(<RecentWorks onOpen={vi.fn()} onOpenAll={vi.fn()} />));
  }

  it.each([
    ['en', 30_000, 'Just now'],
    ['en', 60_000, '1 minute ago'],
    ['en', 5 * 60_000, '5 minutes ago'],
    ['en', 3600_000, '1 hour ago'],
    ['en', 3 * 3600_000, '3 hours ago'],
    ['en', 86400_000, '1 day ago'],
    ['en', 4 * 86400_000, '4 days ago'],
    ['zh', 30_000, '刚刚'],
    ['zh', 60_000, '1分钟前'],
    ['zh', 5 * 60_000, '5分钟前'],
    ['zh', 3600_000, '1小时前'],
    ['zh', 3 * 3600_000, '3小时前'],
    ['zh', 86400_000, '1天前'],
    ['zh', 4 * 86400_000, '4天前'],
  ] as const)('renders %s relative time after %ims through the actual recent-work card', (language, elapsed, expected) => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    writeShellLanguage(language);
    mocks.result = { ...mocks.result, artifacts: [artifact('original', now - elapsed)] };
    render();
    expect(host.querySelector('.recent-work-time')?.textContent).toBe(expected);
  });

  it('keeps relative time with the conversation so the author footer has the complete identity and action', () => {
    mocks.result = { ...mocks.result, artifacts: [artifact('original', Date.now())] };
    render();
    expect(host.querySelector('.work-gallery-subtitle')?.textContent).toContain('刚刚');
    expect(host.querySelector('.work-gallery-footer')?.textContent).not.toContain('刚刚');
    expect(host.querySelector('.work-gallery-footer')?.textContent).toContain('砚砚');
    expect(host.querySelector('.work-gallery-footer')?.textContent).toContain('去聊');
  });

  it('asks for the existing bounded twelve-work view and shows partial results when the scan is incomplete', () => {
    mocks.result = {
      ...mocks.result,
      artifacts: [artifact('one', 2), artifact('two', 1)],
      complete: false,
    };
    render();

    expect(mocks.useGlobalArtifacts).toHaveBeenCalledWith(true, { view: 'recent-works', limit: 12 }, undefined);
    expect(host.querySelectorAll('[data-testid="recent-work-card"]')).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('treats zero results from an incomplete scan as a retryable failure, not an empty café', () => {
    mocks.result = { ...mocks.result, complete: false };
    render();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('最近的作品暂时没有读到');
    expect(host.textContent).not.toContain('还没有最近的作品');
  });

  it('shows the genuine empty state only after the bounded scan is complete', () => {
    render();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('还没有最近的作品');
  });

  it('keeps opening the work distinct from discussing its original author', () => {
    mocks.result = { ...mocks.result, artifacts: [artifact('one', 2)] };
    const open = vi.fn();
    const discuss = vi.fn();
    act(() => root.render(<RecentWorks onOpen={open} onOpenAll={vi.fn()} onDiscuss={discuss} />));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="recent-work-card"]')?.click());
    expect(open).toHaveBeenCalledExactlyOnceWith(mocks.result.artifacts[0]);
    expect(discuss).not.toHaveBeenCalled();
    const chat = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('去聊'));
    expect(chat).toBeDefined();
    act(() => chat!.click());
    expect(discuss).toHaveBeenCalledExactlyOnceWith(mocks.result.artifacts[0]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it.each([
    true,
    false,
  ])('scrolls past the first bounded read without treating incomplete sources as exhausted: %s', (complete) => {
    let visible: IntersectionObserverCallback = () => {};
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          visible = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const all = Array.from({ length: 60 }, (_, i) => artifact(`work-${i}`, 1000 - i));
    mocks.result = { ...mocks.result, artifacts: all.slice(0, 12) };
    mocks.all = { ...mocks.result, artifacts: all, workLineage: 'resolved', complete };
    render();
    expect(host.querySelectorAll('[data-testid="recent-work-card"]')).toHaveLength(12);
    const scroll = () =>
      act(() => visible([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(mocks.useGlobalArtifacts).not.toHaveBeenCalledWith(true, { view: 'works' }, undefined);
    act(() => host.querySelector<HTMLButtonElement>('.work-gallery-more')?.click());
    expect(mocks.useGlobalArtifacts).toHaveBeenCalledWith(true, { view: 'works' }, undefined);
    if (!complete) {
      expect(host.querySelectorAll('[data-testid="recent-work-card"]')).toHaveLength(12);
      expect(host.textContent).not.toContain('这就是全部了');
      mocks.all = { ...mocks.all!, complete: true };
      render();
    }
    expect(host.querySelectorAll('[data-testid="recent-work-card"]')).toHaveLength(24);
    scroll();
    expect(host.querySelectorAll('[data-testid="recent-work-card"]')).toHaveLength(48);
    scroll();
    expect(host.querySelectorAll('[data-testid="recent-work-card"]')).toHaveLength(60);
    expect(host.textContent).toContain('这就是全部了');
  });
  it('does not automatically drain the catalogue when the homepage initial read becomes ready', () => {
    const observe = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = observe;
        disconnect() {}
      },
    );
    mocks.all = { ...mocks.result, workLineage: 'resolved' };
    mocks.result = { ...mocks.result, loading: true };
    render();
    expect(observe).not.toHaveBeenCalled();
    mocks.result = { ...mocks.result, loading: false, artifacts: [artifact('loaded', 2)] };
    render();
    expect(observe).not.toHaveBeenCalled();
    expect(mocks.useGlobalArtifacts).not.toHaveBeenCalledWith(true, { view: 'works' }, undefined);
  });

  it.each([
    'error',
    'loading',
  ] as const)('keeps the selected complete catalogue visible when the initial read is %s', (state) => {
    mocks.result = { ...mocks.result, artifacts: [artifact('initial', 3)] };
    mocks.all = {
      ...mocks.result,
      artifacts: [artifact('complete-one', 2), artifact('complete-two', 1)],
      workLineage: 'resolved',
    };
    render();
    act(() => host.querySelector<HTMLButtonElement>('.work-gallery-more')?.click());
    mocks.result = { ...mocks.result, [state]: true };
    render();
    expect(host.querySelectorAll('[data-testid="recent-work-card"]')).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('这就是全部了');
  });

  it('keeps the known recent prefix while an older partial batch arrives, including after a continuation failure', () => {
    mocks.result = { ...mocks.result, artifacts: [artifact('newest', 100)] };
    mocks.all = {
      ...mocks.result,
      artifacts: [artifact('older', 1)],
      workLineage: 'resolved',
      complete: false,
      loadingMore: false,
    };
    render();
    act(() => host.querySelector<HTMLButtonElement>('.work-gallery-more')?.click());
    expect(host.querySelectorAll('[data-testid="recent-work-card"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="recent-work-card"] .work-gallery-title')?.getAttribute('title')).toBe(
      'newest',
    );
    mocks.all = { ...mocks.all, loadingMore: false, error: true };
    render();
    expect(host.querySelectorAll('[data-testid="recent-work-card"]')).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain('这就是全部了');
  });

  it('keeps reading rather than declaring failure when a partial batch contains only a PR and later image pages are pending', () => {
    mocks.result = { ...mocks.result, artifacts: [artifact('initial', 3)] };
    mocks.all = {
      ...mocks.result,
      artifacts: [{ ...artifact('PR', 1), type: 'pr' }],
      workLineage: 'resolved',
      complete: false,
      loadingMore: false,
    };
    render();
    act(() => host.querySelector<HTMLButtonElement>('.work-gallery-more')?.click());
    mocks.result = { ...mocks.result, artifacts: [], error: true };
    mocks.all = { ...mocks.all, loadingMore: true };
    render();
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
