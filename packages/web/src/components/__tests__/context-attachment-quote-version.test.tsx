import type { ContextAttachment } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextAttachmentList } from '@/components/ContextAttachmentView';
import { useChatStore } from '@/stores/chatStore';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', async (original) => ({
  ...(await original<typeof import('@/utils/api-client')>()),
  apiFetch: (...args: unknown[]) => mocks.fetch(...args),
}));

const DIGEST = `sha256:${'c3'.repeat(32)}`;
const UNCONFIRMED = '无法确认当前位置';

const fileSource = { kind: 'workspace_file', path: 'docs/a.md', worktreeId: 'wt-1' } as const;

function quote(id: string, source: unknown, comment?: string): ContextAttachment {
  return {
    v: 1,
    id,
    kind: 'quote',
    text: `passage ${id}`,
    ...(comment ? { comment } : {}),
    source,
  } as unknown as ContextAttachment;
}

describe('a reference to a place in a file says whether it knows which version that place is in', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(async () => new Response('{}'));
    useChatStore.setState({ currentThreadId: 'thread', workspaceOpenFileLine: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = (attachments: ContextAttachment[]) =>
    act(() => root.render(<ContextAttachmentList attachments={attachments} compact />));
  const card = (id: string) => container.querySelector(`[data-testid="context-attachment-${id}"]`);
  const open = async (id: string) => {
    const revision = useChatStore.getState().workspaceOpenRevision;
    await act(async () => {
      card(id)?.querySelector<HTMLButtonElement>('button')?.click();
      await vi.waitFor(() => expect(useChatStore.getState().workspaceOpenRevision).toBeGreaterThan(revision));
    });
  };

  it('a file quote with no version (an old one) says it cannot confirm where that place is now', () => {
    render([quote('old', fileSource)]);
    expect(card('old')?.textContent).toContain(UNCONFIRMED);
  });

  it('a file quote that names its version says nothing of the kind', () => {
    render([quote('new', { ...fileSource, revision: DIGEST })]);
    expect(card('new')?.textContent).toContain('passage new');
    expect(card('new')?.textContent).not.toContain(UNCONFIRMED);
  });

  it('only a file quote is judged: a quote of a message or of CLI output has no file version to lack', () => {
    render([
      quote('msg', { kind: 'message', threadId: 't-1', messageId: 'm-1' }),
      quote('cli', { kind: 'cli_output', threadId: 't-1', messageId: 'm-1' }),
    ]);
    expect(container.textContent).not.toContain(UNCONFIRMED);
  });

  it('says it in the numbered annotation list too, for exactly the reference that lacks a version', () => {
    render([
      quote('with-version', { ...fileSource, revision: DIGEST }, '保留'),
      quote('without-version', fileSource, '换一个词'),
    ]);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="context-annotations-summary"]')?.click());
    const versioned = container.querySelector('[data-testid="context-annotation-item-with-version"]');
    const unversioned = container.querySelector('[data-testid="context-annotation-item-without-version"]');
    expect(versioned?.textContent).toContain('passage with-version');
    expect(versioned?.textContent).not.toContain(UNCONFIRMED);
    expect(unversioned?.textContent).toContain(UNCONFIRMED);
  });

  it('opens an old or changed quote without guessing its old line in the current file', async () => {
    render([quote('old', { ...fileSource, lineStart: 12, lineEnd: 12 })]);
    await open('old');
    expect(useChatStore.getState().workspaceOpenFileLine).toBeNull();
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).startsWith('/api/workspace/file?'))).toBe(false);
    mocks.fetch.mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).startsWith('/api/workspace/file?') ? { path: fileSource.path, sha256: 'a'.repeat(64) } : {},
          ),
        ),
    );
    render([quote('changed', { ...fileSource, revision: DIGEST, lineStart: 12, lineEnd: 12 })]);
    await open('changed');
    expect(useChatStore.getState().workspaceOpenFileLine).toBeNull();
    expect(card('changed')?.textContent).toContain('原文已改');
  });

  it('uses the quoted line only after the file owner confirms the exact displayed version', async () => {
    mocks.fetch.mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).startsWith('/api/workspace/file?') ? { path: fileSource.path, sha256: DIGEST.slice(7) } : {},
          ),
        ),
    );
    render([quote('exact', { ...fileSource, revision: DIGEST, lineStart: 12, lineEnd: 12 })]);
    await open('exact');
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).startsWith('/api/workspace/file?'))).toBe(true);
    expect(useChatStore.getState().workspaceOpenFileLine).toBe(12);
  });
});
