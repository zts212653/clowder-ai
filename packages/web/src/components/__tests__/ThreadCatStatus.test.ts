import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ThreadState } from '@/stores/chat-types';
import { DEFAULT_THREAD_STATE } from '@/stores/chat-types';
import { getCatStatusType, ThreadCatStatus } from '../ThreadCatStatus';

function makeState(catStatuses: Record<string, string>, unread = 0): ThreadState {
  return {
    ...DEFAULT_THREAD_STATE,
    catStatuses: catStatuses as ThreadState['catStatuses'],
    unreadCount: unread,
  };
}

describe('ThreadCatStatus', () => {
  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
  });
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
  });

  it('returns null when idle and no unread', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadCatStatus, { threadState: makeState({}), unreadCount: 0 }),
    );
    expect(html).toBe('');
  });

  it('shows bouncing cat when a cat is streaming', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadCatStatus, { threadState: makeState({ opus: 'streaming' }), unreadCount: 0 }),
    );
    expect(html).toContain('ᓚᘏᗢ');
    expect(html).toContain('animate-cat-bounce');
    expect(html).toContain('text-amber-500');
  });

  it('shows green cat + check when done', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadCatStatus, { threadState: makeState({ opus: 'done' }), unreadCount: 0 }),
    );
    expect(html).toContain('ᓚᘏᗢ');
    expect(html).toContain('text-green-500');
    expect(html).toContain('✓');
  });

  it('shows red shaking cat on error', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadCatStatus, { threadState: makeState({ opus: 'error' }), unreadCount: 0 }),
    );
    expect(html).toContain('ᓚᘏᗢ');
    expect(html).toContain('animate-cat-shake');
    expect(html).toContain('text-red-500');
  });

  it('shows unread badge', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadCatStatus, { threadState: makeState({}), unreadCount: 5 }),
    );
    expect(html).toContain('5');
    expect(html).toContain('bg-amber-500');
  });

  it('caps unread at 99+', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadCatStatus, { threadState: makeState({}), unreadCount: 150 }),
    );
    expect(html).toContain('99+');
  });

  it('shows both cat and unread badge together', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadCatStatus, {
        threadState: makeState({ codex: 'streaming' }),
        unreadCount: 3,
      }),
    );
    expect(html).toContain('ᓚᘏᗢ');
    expect(html).toContain('3');
  });

  it('error takes priority over streaming', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadCatStatus, {
        threadState: makeState({ opus: 'streaming', codex: 'error' }),
        unreadCount: 0,
      }),
    );
    expect(html).toContain('text-red-500');
  });

  it('shows paw badge when hasUserMention is true', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadCatStatus, {
        threadState: makeState({}, 1),
        unreadCount: 1,
        hasUserMention: true,
      }),
    );
    expect(html).toContain('<svg');
    expect(html).toContain('猫猫 @ 了你');
  });

  it('shows red unread badge when hasUserMention is true', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadCatStatus, {
        threadState: makeState({}, 3),
        unreadCount: 3,
        hasUserMention: true,
      }),
    );
    expect(html).toContain('bg-red-500');
    expect(html).not.toContain('bg-amber-500');
  });

  it('shows amber unread badge when no user mention', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadCatStatus, {
        threadState: makeState({}, 3),
        unreadCount: 3,
        hasUserMention: false,
      }),
    );
    expect(html).toContain('bg-amber-500');
  });

  it('renders paw even with zero unread when hasUserMention', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThreadCatStatus, {
        threadState: { ...DEFAULT_THREAD_STATE, hasUserMention: true },
        unreadCount: 0,
        hasUserMention: true,
      }),
    );
    expect(html).toContain('<svg');
  });
});

describe('getCatStatusType', () => {
  it('returns idle for empty', () => {
    expect(getCatStatusType({})).toBe('idle');
  });

  it('returns error when any cat has error', () => {
    expect(getCatStatusType({ opus: 'done', codex: 'error' })).toBe('error');
  });

  it('returns working when streaming', () => {
    expect(getCatStatusType({ opus: 'streaming' })).toBe('working');
  });

  it('returns working when pending', () => {
    expect(getCatStatusType({ opus: 'pending' })).toBe('working');
  });

  it('returns done when all done', () => {
    expect(getCatStatusType({ opus: 'done', codex: 'done' })).toBe('done');
  });
});
