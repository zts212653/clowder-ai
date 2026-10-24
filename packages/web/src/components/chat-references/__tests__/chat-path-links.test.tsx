import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { ChatFileActions } from '../ChatFileActions';
import styles from '../chat-reference.module.css';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'http://localhost:3172' }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useChatStore.setState({ currentThreadId: 'thread_paths', currentProjectPath: '/registered/project' });
  vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    return Response.json({
      groups: request.groups.map((group: { threadId: string; references: string[] }) => ({
        ...group,
        results: group.references.map((reference) => ({
          reference,
          target: reference.startsWith('https://github.com/')
            ? {
                kind: 'github',
                repo: 'owner/repo',
                number: 5963,
                objectType: 'pull',
                title: 'A real pull request title that is too long to fit the inline chip',
                state: 'merged',
                worktreeId: 'project',
                url: reference,
              }
            : reference === 'gone.md' || reference === 'docs/not-here.md'
              ? { kind: 'missing' }
              : {
                  kind: 'file',
                  entryType: 'file',
                  worktreeId: 'project',
                  path: reference.replace(/:\d+$/, ''),
                  absolutePath: `/registered/project/${reference.replace(/:\d+$/, '')}`,
                  line: reference.includes(':') ? 7 : null,
                  mime: 'text/markdown',
                  size: 42,
                  modifiedAt: '2026-10-23T08:00:00Z',
                },
        })),
      })),
    });
  });
});

it('keeps sentence references compact, filename-only and free of persistent file-action controls', async () => {
  await act(async () => {
    root.render(
      <MarkdownContent
        referenceThreadId="thread_visual"
        content={
          'Read `docs/compact.md:7`; the missing file is `docs/not-here.md`. See [the work](https://github.com/owner/repo/pull/5963).\n\n`docs/standalone.md`'
        }
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const inline = container.querySelector('[data-chat-reference-kind=file][data-chat-reference-layout=inline]');
  expect(inline?.textContent).toBe('compact.md:7');
  expect(inline?.querySelectorAll('button')).toHaveLength(1);
  expect(inline?.getAttribute('title')).toBe('/registered/project/docs/compact.md');
  const missing = container.querySelector('[data-chat-reference-kind=missing]');
  expect(missing?.textContent).toBe('not-here.md');
  expect(missing?.querySelector('svg')).not.toBeNull();
  const pr = container.querySelector('[data-chat-reference-kind=github]');
  expect(pr?.getAttribute('data-chat-reference-layout')).toBe('inline');
  expect(pr?.closest('p')?.textContent).toContain('See ');
  expect(pr?.textContent).toContain('#5963');
  expect(pr?.textContent).not.toContain('too long to fit the inline chip');
  expect(pr?.querySelector('[data-chat-reference-state]')?.textContent).toMatch(/Merged|已合入/);
  expect(container.querySelector('[data-chat-reference-layout=card]')?.textContent).not.toContain('⋯');
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it('recognizes a whole code span, prose and a Markdown path link in one batch across messages', async () => {
  await act(async () => {
    root.render(
      <>
        <MarkdownContent referenceThreadId="thread_paths" content={'Read `docs/报告.md:7` and docs/second.md .'} />
        <MarkdownContent
          referenceThreadId="thread_paths"
          content={'[Report](docs/third.md)\n\n```text\ndocs/code-only.md\n```'}
        />
      </>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(container.querySelectorAll('[data-chat-reference-kind=file]')).toHaveLength(3);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(vi.mocked(apiFetch).mock.calls[0][1]?.body));
  expect(body.groups[0].references).toEqual(
    expect.arrayContaining(['docs/报告.md:7', 'docs/second.md', 'docs/third.md']),
  );
  expect(JSON.stringify(body)).not.toContain('code-only');
  const file = container.querySelector<HTMLButtonElement>('[data-chat-reference-kind=file] button');
  await act(async () => file?.click());
  expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/报告.md');
  expect(useChatStore.getState().workspaceOpenFileLine).toBe(7);
});
it('explains a confirmed missing file without navigation and styles a standalone existing path as a card', async () => {
  await act(async () => {
    root.render(<MarkdownContent referenceThreadId="thread_paths" content={'`gone.md`\n\n`docs/card.md`'} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const missing = container.querySelector('[data-chat-reference-kind=missing]');
  expect(missing?.querySelector('a')).toBeNull();
  expect(missing?.textContent).toContain('gone.md');
  const before = useChatStore.getState().workspaceOpenFilePath;
  await act(async () => (missing as HTMLButtonElement)?.click());
  expect(useChatStore.getState().workspaceOpenFilePath).toBe(before);
  expect(document.querySelector('[role=tooltip]')?.textContent).toMatch(/不在了|no longer here/);
  expect(container.querySelector('[data-chat-reference-layout=card]')?.textContent).toContain('card.md');
});

it('keeps the file action menu inside a 390px viewport and closes it with Escape', async () => {
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('innerHeight', 800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 110,
    y: 70,
    right: 135,
    left: 110,
    top: 70,
    bottom: 90,
    width: 25,
    height: 20,
    toJSON: () => ({}),
  });
  await act(async () =>
    root.render(
      <ChatFileActions
        visible
        target={{
          kind: 'file',
          entryType: 'file',
          worktreeId: 'project',
          path: 'docs/test.md',
          absolutePath: '/registered/project/docs/test.md',
          line: null,
          mime: 'text/markdown',
          size: 20,
          modifiedAt: '',
        }}
      />,
    ),
  );
  const menu = document.body.querySelector<HTMLElement>('[role=group]');
  expect(container.contains(menu)).toBe(false);
  expect(menu?.style.position).toBe('fixed');
  expect(menu?.style.left).toBe('16px');
  await act(async () => menu?.querySelector('button')?.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(document.body.querySelector('[role=group]')).toBe(menu);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(document.body.querySelector('[role=group]')).toBeNull();
});

it('keeps ambiguous prose and whole code spans literal in an enabled Chat reference scope', async () => {
  const words = [
    'zh/en',
    'F225/F231',
    'PPT/Word/Excel',
    '@cat-cafe/shared',
    'owner/repo',
    '16/9.5',
    '2026/10/23',
    'v1.2',
    '127.0.0.1',
    'object.property',
  ];
  vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
    const { groups } = JSON.parse(String(options?.body));
    return Response.json({
      groups: groups.map((group: { threadId: string; references: string[] }) => ({
        ...group,
        results: group.references.map((reference) => ({ reference, target: null })),
      })),
    });
  });
  await act(async () => {
    root.render(
      <MarkdownContent
        referenceThreadId="thread_prose_regression"
        content={words.join(' ') + '\n\n' + words.map((word) => '`' + word + '`').join(' ')}
      />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(apiFetch).toHaveBeenCalled();
  expect(container.querySelector('[data-chat-reference-kind]')).toBeNull();
  expect([...container.querySelectorAll('p')].some((paragraph) => paragraph.classList.contains(styles.grid))).toBe(
    false,
  );
  for (const word of words) expect(container.textContent).toContain(word);
});

it('keeps a partially verified candidate group in sentence flow and makes only fully verified groups cards', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
    const { groups } = JSON.parse(String(options?.body));
    return Response.json({
      groups: groups.map((group: { threadId: string; references: string[] }) => ({
        ...group,
        results: group.references.map((reference) => ({
          reference,
          target:
            reference === 'object.property'
              ? null
              : {
                  kind: 'file',
                  entryType: 'file',
                  worktreeId: 'project',
                  path: reference,
                  absolutePath: `/registered/project/${reference}`,
                  line: null,
                  mime: 'text/markdown',
                  size: 42,
                  modifiedAt: '2026-10-23T08:00:00Z',
                },
        })),
      })),
    });
  });
  await act(async () =>
    root.render(
      <MarkdownContent
        referenceThreadId="thread_group_regression"
        content={'`docs/verified.md`\n`object.property`\n\n`docs/one.md`\n`docs/two.md`\n`docs/three.md`'}
      />,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const [mixed, verified] = container.querySelectorAll('p');
  expect(mixed.classList.contains(styles.grid)).toBe(false);
  expect(mixed.querySelector('[data-chat-reference-layout]')?.getAttribute('data-chat-reference-layout')).toBe(
    'inline',
  );
  expect(mixed.textContent).toContain('object.property');
  expect(mixed.querySelectorAll('br')).toHaveLength(1);
  expect(verified.classList.contains(styles.grid)).toBe(true);
  expect(verified.querySelectorAll('[data-chat-reference-layout=card]')).toHaveLength(3);
  expect(verified.querySelectorAll(':scope > br')).toHaveLength(0);
  expect(verified.children).toHaveLength(3);
});

it('consumes historical worktree hints without exposing them or resolving against the active project', async () => {
  useChatStore.setState({ currentThreadId: 'thread_legacy_regression' });
  vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
    const { groups } = JSON.parse(String(options?.body));
    return Response.json({
      groups: groups.map((group: { threadId: string; references: string[] }) => ({
        ...group,
        results: group.references.map((reference) => ({
          reference,
          target: reference.endsWith('[wt:old-root]')
            ? {
                kind: 'file',
                entryType: 'file',
                worktreeId: 'old-root',
                path: 'docs/history.md',
                absolutePath: '/registered/old-root/docs/history.md',
                line: 7,
                mime: 'text/markdown',
                size: 42,
                modifiedAt: '2026-10-23T08:00:00Z',
              }
            : null,
        })),
      })),
    });
  });
  await act(async () => {
    root.render(
      <MarkdownContent
        referenceThreadId="thread_legacy_regression"
        content={'`docs/history.md:7` [wt:old-root] and docs/other.md[wt:missing-root]'}
      />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(container.textContent).not.toContain('[wt:');
  const requests = vi
    .mocked(apiFetch)
    .mock.calls.map((call) => String(call[1]?.body))
    .join('');
  expect(requests).toContain('docs/history.md:7 [wt:old-root]');
  expect(requests).toContain('docs/other.md [wt:missing-root]');
  expect(container.textContent).toContain('docs/other.md');
  expect(container.querySelectorAll('[data-chat-reference-kind=file]')).toHaveLength(1);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-chat-reference-kind=file] button')?.click());
  expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/history.md');
  expect(useChatStore.getState().workspaceWorktreeId).toBe('old-root');
});

it('exposes full GitHub titles and missing-file explanations through focusable accessible controls', async () => {
  await act(async () => {
    root.render(
      <MarkdownContent
        referenceThreadId="thread_accessible_regression"
        content={'See [work](https://github.com/owner/repo/pull/5963) and `docs/not-here.md`.'}
      />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const github = container.querySelector('[data-chat-reference-kind=github] button');
  expect(github?.getAttribute('aria-label')).toContain('too long to fit the inline chip');
  const missing = container.querySelector<HTMLElement>('[data-chat-reference-kind=missing]');
  expect(missing?.tabIndex).toBe(0);
  expect(missing?.getAttribute('aria-label')).toMatch(/不在了|no longer here/);
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    return selector === ':focus-visible' || matches.call(this, selector);
  });
  await act(async () => {
    missing?.focus();
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  expect(document.querySelector('[role=tooltip]')?.textContent).toMatch(/不在了|no longer here/);
});
