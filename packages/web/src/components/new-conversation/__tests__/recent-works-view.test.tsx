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
}));

vi.mock('@/hooks/useGlobalArtifacts', () => ({
  useGlobalArtifacts: (...args: unknown[]) => {
    mocks.useGlobalArtifacts(...args);
    return mocks.result;
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
    'empty',
    'error',
    'loading',
    'partial',
  ] as const)('keeps both catalogue entrances usable with a %s preview', (state) => {
    const openAll = vi.fn();
    mocks.result = {
      ...mocks.result,
      loading: state === 'loading',
      error: state === 'error',
      complete: state !== 'partial',
    };
    act(() => root.render(<RecentWorks onOpen={vi.fn()} onOpenAll={openAll} />));
    const top = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('全部作品'));
    const bottom = host.querySelector<HTMLButtonElement>('.work-gallery-more');
    expect(top).toBeDefined();
    expect(bottom?.textContent).toContain('打开作品目录');
    act(() => {
      top?.click();
      bottom?.click();
    });
    expect(openAll).toHaveBeenCalledTimes(2);
    expect(mocks.useGlobalArtifacts).not.toHaveBeenCalledWith(true, { view: 'works' }, undefined);
  });

  it('caps the preview at 12 without admitting an inline full reader on click or scroll', () => {
    const openAll = vi.fn();
    mocks.result = {
      ...mocks.result,
      artifacts: Array.from({ length: 60 }, (_, i) => artifact('work-' + i, 1000 - i)),
    };
    act(() => root.render(<RecentWorks onOpen={vi.fn()} onOpenAll={openAll} />));
    expect(host.querySelectorAll('[data-testid="recent-work-card"]')).toHaveLength(12);
    act(() => {
      host.dispatchEvent(new Event('scroll'));
      host.querySelector<HTMLButtonElement>('.work-gallery-more')?.click();
    });
    expect(openAll).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll('[data-testid="recent-work-card"]')).toHaveLength(12);
    expect(mocks.useGlobalArtifacts).not.toHaveBeenCalledWith(true, { view: 'works' }, undefined);
  });
});
