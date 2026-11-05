import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { SavedPathsV2 } from '@/components/workspace/SavedPathsV2';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { ContentLandingHeader } from '../content-review/ContentLandingHeader';
import { parseFileNavigationOrigin } from '../file-navigation-origin';
import { workspaceFileReturnAction } from '../workspace-file-return';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

describe('C 3480 meeting-transcript origin — parser', () => {
  it('accepts a legal persisted origin', () => {
    expect(parseFileNavigationOrigin({ kind: 'meeting-transcript', threadId: 'thread-1' })).toEqual({
      kind: 'meeting-transcript',
      threadId: 'thread-1',
    });
  });

  it('fails closed on illegal threadIds and never degrades into another kind', () => {
    expect(parseFileNavigationOrigin({ kind: 'meeting-transcript', threadId: '' })).toBeNull();
    expect(parseFileNavigationOrigin({ kind: 'meeting-transcript', threadId: '  ' })).toBeNull();
    expect(parseFileNavigationOrigin({ kind: 'meeting-transcript', threadId: 'a\0b' })).toBeNull();
    expect(parseFileNavigationOrigin({ kind: 'meeting-transcript', threadId: 42 })).toBeNull();
    expect(parseFileNavigationOrigin({ kind: 'meeting-transcript', threadId: 'x'.repeat(257) })).toBeNull();
  });
});

describe('C 3480 meeting-transcript origin — return action', () => {
  it('stays itself and never falls into the chat-file-link messageId read', () => {
    const action = workspaceFileReturnAction({ kind: 'meeting-transcript', threadId: 'thread-1' }, 'wt-1');
    expect(action).toEqual({ kind: 'meeting-transcript', threadId: 'thread-1' });
    expect(action).not.toHaveProperty('messageId');
  });
});

describe('C 3480 meeting-transcript origin — source label', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('names the meeting source explicitly instead of the generic 返回来源', async () => {
    await act(async () => {
      root.render(
        <ContentLandingHeader
          title="meeting.md"
          navigationOrigin={{ kind: 'meeting-transcript', threadId: 'thread-1' }}
          onBack={() => {}}
        />,
      );
    });
    expect(container.textContent).toContain('‹ 会议伴随');
    expect(container.textContent).not.toContain('返回来源');
  });

  it('R2 probe: meeting return label follows the v2 English preference', async () => {
    writeShellLanguage('en');
    try {
      await act(async () => {
        root.render(
          <ContentLandingHeader
            title="meeting.md"
            navigationOrigin={{ kind: 'meeting-transcript', threadId: 'thread-1' }}
            onBack={() => {}}
          />,
        );
      });
      expect(container.textContent).toContain('Meeting companion');
      expect(container.textContent).not.toContain('会议伴随');
    } finally {
      writeShellLanguage('zh');
    }
  });

  it('names a file-tree return without presenting it as a meeting source', async () => {
    await act(async () => {
      root.render(
        <ContentLandingHeader
          title="meeting.md"
          navigationOrigin={{ kind: 'file-tree', worktreeId: 'wt-1' }}
          onBack={() => {}}
        />,
      );
    });
    expect(container.textContent).toContain('‹ 文件');
    expect(container.textContent).not.toContain('‹ 会议伴随');
  });
});

describe('C 3480 meeting-transcript origin — SavedPathsV2 open carries the origin', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/workspace/worktrees')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            worktrees: [{ id: 'wt-1', root: '/repo/main', resolvedRoot: '/repo/main', branch: 'main', head: 'abc' }],
          }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    writeShellPresentation('v2');
    useChatStore.setState({ currentThreadId: 'meeting-thread', workspaceWorktreeId: 'wt-1' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellPresentation('classic');
  });

  it('opening a saved meeting file carries the meeting origin', async () => {
    await act(async () => {
      // R4-P1a: the parent passes the capture session's owner; SavedPathsV2 claims the origin from it,
      // never from whichever chat thread is selected.
      root.render(<SavedPathsV2 savedPath="/repo/main/transcripts/meeting.md" ownerThreadId="meeting-thread" />);
    });
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-testid="saved-path-open"]') as HTMLButtonElement).click();
    });
    expect(useChatStore.getState()._workspaceFileSetAt.navigationOrigin).toEqual({
      kind: 'meeting-transcript',
      threadId: 'meeting-thread',
    });
  });

  it('an unknown capture owner claims no meeting origin (fail-closed, R4-P1b)', async () => {
    await act(async () => {
      root.render(<SavedPathsV2 savedPath="/repo/main/transcripts/meeting.md" />);
    });
    await act(async () => {});
    await act(async () => {
      (container.querySelector('[data-testid="saved-path-open"]') as HTMLButtonElement).click();
    });
    expect(useChatStore.getState()._workspaceFileSetAt.navigationOrigin).toBeUndefined();
  });
});

// Same-thread mode restore and wrong-thread fail-closed are covered by real host tests in
// F307ExperienceWorkbench.test.tsx ("returns a meeting-opened file…" / "a meeting origin from another thread…");
// the stopped-result restore across a panel departure is covered in TranscriptPanelV2.test.tsx, and the classic
// no-entry control in TranscriptPanel.test.tsx.
