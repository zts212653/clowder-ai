import type { ChatFileReference } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'http://localhost:3172' }));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellPresentation('v2');
  writeShellLanguage('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useChatStore.setState({ currentThreadId: 'thread_directory_labels', currentProjectPath: '/registered/project' });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(apiFetch).mockReset();
  writeShellLanguage('zh');
  writeShellPresentation('classic');
  vi.unstubAllGlobals();
});

it.each([
  { path: '.', absolutePath: '/registered/project', name: 'project', parent: '/registered/', entryType: 'directory' },
  { path: './', absolutePath: '/registered/project', name: 'project', parent: '/registered/', entryType: 'directory' },
  { path: '', absolutePath: '/registered/project', name: 'project', parent: '/registered/', entryType: 'directory' },
  {
    path: 'docs/notes',
    absolutePath: '/registered/project/docs/notes',
    name: 'notes',
    parent: '/registered/project/docs/',
    entryType: 'directory',
  },
  {
    path: 'README.md',
    absolutePath: '/registered/project/README.md',
    name: 'README.md',
    parent: '/registered/project/',
    entryType: 'file',
  },
] as const)('shows a real name and containing directory for $entryType $path', async ({
  path,
  absolutePath,
  name,
  parent,
  entryType,
}) => {
  const target: ChatFileReference = {
    kind: 'file',
    entryType,
    path,
    absolutePath,
    worktreeId: 'project',
    line: null,
    mime: entryType === 'directory' ? 'inode/directory' : 'text/markdown',
    size: 2528,
    modifiedAt: '2026-10-28T06:43:22.053Z',
  };
  vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    return Response.json({
      groups: request.groups.map((group: { threadId: string; references: string[] }) => ({
        threadId: group.threadId,
        results: group.references.map((reference) => ({ reference, target })),
      })),
    });
  });
  await act(async () => {
    root.render(
      <MarkdownContent
        referenceThreadId="thread_directory_labels"
        content={`[Original directory](<${absolutePath}>)`}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const card = container.querySelector('[data-chat-reference-kind="file"][data-chat-reference-layout="card"]');
  expect(card).not.toBeNull();
  expect(card?.querySelector('[data-chat-file-name]')?.textContent).toBe(name);
  expect(card?.querySelector('[data-chat-file-name]')?.nextElementSibling?.textContent).toBe(parent);
  expect(card?.getAttribute('title')).toBe(absolutePath);
  expect(card?.querySelector('[data-chat-file-metadata]')?.textContent).toContain(
    entryType === 'directory' ? 'Folder' : 'Markdown',
  );
  await act(async () => card?.querySelector<HTMLButtonElement>('button')?.click());
  const state = useChatStore.getState();
  // The existing Workspace owner canonicalizes root aliases before navigation.
  expect(state.workspaceOpenRequest?.target).toMatchObject({
    worktreeId: 'project',
    path: path === './' || path === '' ? '.' : path,
  });
  if (entryType === 'directory') expect(state.workspaceOpenRequest?.target.kind).toBe('reveal');
});
