import { projectMarkdownReadableText } from '@cat-cafe/shared';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatReferenceScope } from '@/components/chat-references/ChatReferenceScope';
import { MarkdownContent } from '@/components/MarkdownContent';
import { NativeReplyText } from '@/components/reply-layers/NativeReplyText';
import { refreshMentionData } from '@/lib/mention-highlight';
import { apiFetch } from '@/utils/api-client';
import { useTextSelectionAction } from '../useTextSelectionAction';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'http://localhost:3172' }));

let fileTargets = false,
  threadSequence = 0,
  threadId = '';

function Host({ content, native }: { content: string; native: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const action = useTextSelectionAction(ref, true, content, 'viewport');
  return (
    <>
      <ChatReferenceScope value={threadId}>
        <div ref={ref} data-testid="message" data-context-quote-source="message">
          {native ? (
            <NativeReplyText
              run={{ kind: 'text', id: 'answer', text: content, start: 120, end: 120 + content.length }}
            />
          ) : (
            <MarkdownContent referenceThreadId={threadId} content={content} />
          )}
        </div>
      </ChatReferenceScope>
      <output>{JSON.stringify(action)}</output>
    </>
  );
}

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  fileTargets = false;
  threadId = `reference-selection-${++threadSequence}`;
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  refreshMentionData([
    {
      id: 'codex61-sol',
      displayName: '缅因猫 Sol',
      mentionPatterns: ['@sol'],
      color: { primary: '#000', secondary: '#fff' },
      clientId: 'openai',
      carrier: 'cli',
      avatar: '/avatars/codex.png',
      defaultModel: 'test',
      roleDescription: '',
      personality: '',
    },
  ]);
  vi.mocked(apiFetch).mockImplementation(async (url, options) => {
    if (String(url).includes('/file-info'))
      return Response.json({
        local: true,
        path: '/fixture/docs/hover.md',
        filename: 'hover.md',
        byteLength: 42,
        mime: 'text/markdown',
      });
    const body = JSON.parse(String(options?.body));
    return Response.json({
      groups: body.groups.map((group: { references: string[] }) => ({
        ...group,
        results: group.references.map((reference) => ({
          reference,
          target: fileTargets
            ? reference.startsWith('https://github.com/')
              ? {
                  kind: 'github',
                  repo: 'owner/repo',
                  number: 6756,
                  objectType: 'pull',
                  title: 'Real work',
                  state: 'merged',
                  url: reference,
                  worktreeId: 'project',
                }
              : {
                  kind: 'file',
                  entryType: 'file',
                  worktreeId: 'project',
                  path: reference,
                  absolutePath: `/fixture/${reference}`,
                  line: null,
                  mime: 'application/octet-stream',
                  size: 42,
                  modifiedAt: '2026-11-06T00:00:00Z',
                }
            : { kind: 'missing' },
        })),
      })),
    });
  });
});

async function renderFile(content: string, native = false) {
  fileTargets = true;
  await act(async () => root.render(<Host content={content} native={native} />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const file = container.querySelector<HTMLElement>('[data-chat-reference-kind="file"]');
  if (!file) throw new Error('Missing actual file reference');
  return file;
}

function filenameLabel(file: Element, filename: string) {
  const label = [...file.querySelectorAll('span')].find(
    (node) => node.textContent === filename && node.children.length === 0,
  );
  if (!label) throw new Error('Missing filename text');
  return label;
}

it.each([
  'pdf',
  'docx',
  'pptx',
  'xlsx',
])('quotes a selected %s filename without its decorative badge', async (extension) => {
  const file = await renderFile(`读 [原文](docs/report.${extension}) 后回复。`);
  expect(select(filenameLabel(file, `report.${extension}`))).toMatchObject({ text: '原文', renderedOccurrences: 1 });
});

it('maps a native file-name selection to the original path span', async () => {
  const content = '读 `docs/native.pdf` 后回复。';
  const file = await renderFile(content, true);
  expect(select(filenameLabel(file, 'native.pdf'))).toMatchObject({
    text: 'docs/native.pdf',
    selectionStart: 120 + content.indexOf('docs/native.pdf'),
    selectionEnd: 120 + content.indexOf('docs/native.pdf') + 'docs/native.pdf'.length,
    renderedOccurrences: 1,
  });
});

it('dismisses hover actions before selecting the original Markdown link label', async () => {
  const file = await renderFile('读 [原文](docs/hover.md) 后回复。');
  await act(async () => file.dispatchEvent(new MouseEvent('pointerenter', { buttons: 0 })));
  expect(container.querySelector('[role=menu]')).not.toBeNull();
  await act(async () => file.dispatchEvent(new Event('selectstart', { bubbles: true })));
  expect(container.querySelector('[role=menu]')).toBeNull();
  expect(select(filenameLabel(file, 'hover.md'))).toMatchObject({ text: '原文', renderedOccurrences: 1 });
});

it('keeps a drag and an existing text selection from opening hover actions', async () => {
  const file = await renderFile('读 `docs/drag.md` 后回复。');
  await act(async () => file.dispatchEvent(new MouseEvent('pointerenter', { buttons: 1 })));
  expect(container.querySelector('[role=menu]')).toBeNull();
  select(filenameLabel(file, 'drag.md'));
  await act(async () => file.dispatchEvent(new MouseEvent('pointerenter', { buttons: 0 })));
  expect(container.querySelector('[role=menu]')).toBeNull();
});

it('quotes a GitHub title independently of its state and file-operation controls', async () => {
  fileTargets = true;
  await act(async () =>
    root.render(<Host content="读 [工作说明](https://github.com/owner/repo/pull/6756) 后回复。" native={false} />),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const title = [...container.querySelectorAll('[data-chat-reference-kind=github] span')].find(
    (node) => node.textContent === '#6756 Real work',
  );
  if (!title) throw new Error('Missing GitHub title');
  expect(select(title)).toMatchObject({ text: '工作说明', renderedOccurrences: 1 });
  const paragraph = title.closest('p');
  if (!paragraph) throw new Error('Missing GitHub reference paragraph');
  expect(select(paragraph)).toMatchObject({ text: '读 工作说明 后回复。', renderedOccurrences: 1 });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  refreshMentionData([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function select(element: Element, renderedSelection?: string) {
  const range = document.createRange();
  range.selectNodeContents(element);
  Object.defineProperties(range, {
    getBoundingClientRect: { value: () => new DOMRect(100, 100, 200, 20) },
    getClientRects: { value: () => [new DOMRect(100, 100, 200, 20)] },
  });
  vi.spyOn(window, 'getSelection').mockReturnValue({
    anchorNode: element,
    focusNode: element,
    rangeCount: 1,
    isCollapsed: false,
    getRangeAt: () => range,
    toString: () => renderedSelection ?? range.toString(),
  } as unknown as Selection);
  act(() => document.dispatchEvent(new Event('selectionchange')));
  return JSON.parse(container.querySelector('output')?.textContent ?? 'null');
}

it.each([
  '品味保存在 `docs/taste/vignettes/` 或 `private/taste/`。',
  '检查 docs/taste/vignettes/*.md 和 packages/api/src/ 。',
  '打开 [**原始**报告](docs/original.md) 再看 https://example.com/details 。',
  '请 @codex61-sol 检查这条消息。',
  '请 [@codex61-sol **检查**](docs/nested.md) 再回复。',
  '读 [**品味**原文][taste] 再回复。\n\n[taste]: docs/taste/notes.md',
  '读 [&amp; **原文**][taste] 再回复。\n\n[taste]: docs/taste/notes.md',
  '历史位置 `docs/history.md[wt:old-root]` 和 docs/other.md [wt:old-root] 。',
])('quotes the original readable text behind rendered reference labels: %s', async (content) => {
  await act(async () => root.render(<Host content={content} native={false} />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const paragraph = container.querySelector('[data-testid=message] p');
  if (!paragraph) throw new Error('Missing rendered Markdown paragraph');
  const action = select(paragraph);
  // Only the first visible paragraph is selected; reference definitions are not selected prose.
  expect(action?.text).toBe(projectMarkdownReadableText(content).split('\n\n')[0]);
  expect(action?.renderedOccurrences).toBe(1);
});

it('counts a unique rendered quote when Chromium inserts an extra chip-adjacent line break', async () => {
  const content = '读 `docs/layout.md` 后回复。';
  await act(async () => root.render(<Host content={content} native={false} />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const paragraph = container.querySelector('[data-testid=message] p');
  const message = container.querySelector('[data-testid=message]');
  if (!paragraph || !message) throw new Error('Missing rendered quote');
  // Measured by reference-quote-forward.test.mjs: Selection doubles some inline-flex boundaries.
  Object.defineProperty(message, 'innerText', { value: '读 \nlayout.md\n 后回复。' });
  expect(select(paragraph, '读 \n\nlayout.md\n 后回复。')).toMatchObject({ renderedOccurrences: 1 });
});

it('keeps rendered ambiguity even when restored source paths differ', async () => {
  const content = '打开 `docs/shared.md`。\n\n打开 `other/shared.md`。';
  await act(async () => root.render(<Host content={content} native={false} />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const paragraph = container.querySelector('[data-testid=message] p');
  if (!paragraph) throw new Error('Missing duplicate labels');
  expect(select(paragraph)).toMatchObject({ text: '打开 docs/shared.md。', renderedOccurrences: 2 });
});

it('maps a renamed mention back to its stored native answer span', async () => {
  const content = '请 @codex61-sol 检查这条消息。';
  await act(async () => root.render(<Host content={content} native />));
  const paragraph = container.querySelector('[data-testid=message] p');
  if (!paragraph) throw new Error('Missing native answer');
  expect(paragraph.textContent).toContain('@缅因猫 Sol');
  expect(select(paragraph)).toMatchObject({
    text: content,
    selectionStart: 120,
    selectionEnd: 120 + content.length,
    renderedOccurrences: 1,
  });
});
