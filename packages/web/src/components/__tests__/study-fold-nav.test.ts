import type { StudyMeta } from '@cat-cafe/shared';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock PodcastPlayer to avoid complex deps
vi.mock('@/components/signals/PodcastPlayer', () => ({
  PodcastPlayer: () => React.createElement('div', { 'data-testid': 'podcast-player' }),
}));

// Mock apiFetch — P1 fix: StudyFoldArea now uses apiFetch (not bare fetch) for auth headers
const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { StudyFoldArea } from '@/components/signals/StudyFoldArea';

function makeMeta(overrides: Partial<StudyMeta> = {}): StudyMeta {
  return {
    articleId: 'article_test',
    lastStudiedAt: '2026-03-10T12:00:00Z',
    threads: [],
    artifacts: [],
    collections: [],
    ...overrides,
  };
}

describe('StudyFoldArea navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it('uses linked thread in discuss link instead of /thread/default', () => {
    const meta = makeMeta({
      threads: [{ threadId: 'thread_abc', linkedAt: '2026-03-10T12:00:00Z', linkedBy: 'user' }],
    });

    React.act(() => {
      root.render(
        React.createElement(StudyFoldArea, {
          articleId: 'article_1',
          studyMeta: meta,
          onStartStudy: vi.fn(),
        }),
      );
    });

    // The fold area should be open since lastStudiedAt is set
    const discussLink = container.querySelector('a[href*="signal="]') as HTMLAnchorElement;
    expect(discussLink).toBeTruthy();
    expect(discussLink.getAttribute('href')).toContain('/thread/thread_abc');
    expect(discussLink.getAttribute('href')).not.toContain('/thread/default');
  });

  it('falls back to /thread/default when no linked threads', () => {
    const meta = makeMeta({ threads: [] });

    React.act(() => {
      root.render(
        React.createElement(StudyFoldArea, {
          articleId: 'article_2',
          studyMeta: meta,
          onStartStudy: vi.fn(),
        }),
      );
    });

    const discussLink = container.querySelector('a[href*="signal="]') as HTMLAnchorElement;
    expect(discussLink).toBeTruthy();
    expect(discussLink.getAttribute('href')).toContain('/thread/default');
  });

  it('skips stale threads when resolving discuss thread', () => {
    const meta = makeMeta({
      threads: [
        { threadId: 'thread_stale', linkedAt: '2026-03-09T12:00:00Z', linkedBy: 'user', stale: true },
        { threadId: 'thread_active', linkedAt: '2026-03-10T12:00:00Z', linkedBy: 'user' },
      ],
    });

    React.act(() => {
      root.render(
        React.createElement(StudyFoldArea, {
          articleId: 'article_3',
          studyMeta: meta,
          onStartStudy: vi.fn(),
        }),
      );
    });

    const discussLink = container.querySelector('a[href*="signal="]') as HTMLAnchorElement;
    expect(discussLink.getAttribute('href')).toContain('/thread/thread_active');
  });

  it('note click fetches content via apiFetch (not bare fetch)', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: 'Study insight here' }),
    });

    const meta = makeMeta({
      artifacts: [
        {
          id: 'note_fetch',
          kind: 'note',
          state: 'ready',
          createdAt: '2026-03-10T12:00:00Z',
          createdBy: 'user',
          filePath: '/tmp/note.md',
        },
      ],
    });

    React.act(() => {
      root.render(
        React.createElement(StudyFoldArea, {
          articleId: 'article_fetch',
          studyMeta: meta,
          onStartStudy: vi.fn(),
        }),
      );
    });

    const noteToggle = container.querySelector('[data-testid="note-toggle-note_fetch"]') as HTMLButtonElement;
    await React.act(async () => {
      noteToggle.click();
    });

    // Verify apiFetch was called (not bare fetch) — ensures X-Cat-Cafe-User header is sent
    expect(mockApiFetch).toHaveBeenCalledWith('/api/signals/articles/article_fetch/notes/note_fetch');
    // Content should be rendered
    expect(container.textContent).toContain('Study insight here');
  });

  it('renders note toggle buttons instead of plain text', () => {
    const meta = makeMeta({
      artifacts: [
        {
          id: 'note_1',
          kind: 'note',
          state: 'ready',
          createdAt: '2026-03-10T12:00:00Z',
          createdBy: 'user',
          filePath: '/tmp/note.md',
        },
      ],
    });

    React.act(() => {
      root.render(
        React.createElement(StudyFoldArea, {
          articleId: 'article_4',
          studyMeta: meta,
          onStartStudy: vi.fn(),
        }),
      );
    });

    const noteToggle = container.querySelector('[data-testid="note-toggle-note_1"]') as HTMLButtonElement;
    expect(noteToggle).toBeTruthy();
    expect(noteToggle.tagName).toBe('BUTTON');
    expect(noteToggle.textContent).toContain('note_1');
  });
});
