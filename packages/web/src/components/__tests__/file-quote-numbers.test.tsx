import type { ContextAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentBlocks } from '../ContentBlocks';
import { ContextAttachmentList } from '../ContextAttachmentView';

const quotes: ContextAttachment[] = ['first', 'second'].map((id) => ({
  v: 1,
  id,
  kind: 'quote',
  text: id,
  comment: `说明 ${id}`,
  source: { kind: 'workspace_file', path: 'guide.md', worktreeId: 'work', revision: `sha256:${'a'.repeat(64)}` },
}));
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('the sent file quotes name their original order, independent of non-file attachments', async () => {
  await act(async () =>
    root.render(
      <ContentBlocks
        blocks={[
          { type: 'text', text: '改这两处' },
          {
            type: 'context_attachment',
            attachment: { v: 1, id: 'thread-ref', kind: 'thread', threadId: 'other', title: '其他对话' },
          },
          ...quotes.map((attachment) => ({ type: 'context_attachment' as const, attachment })),
        ]}
      />,
    ),
  );
  expect(container.querySelector('[data-testid="context-attachment-first"]')?.textContent).toContain('第 1 处');
  expect(container.querySelector('[data-testid="context-attachment-second"]')?.textContent).toContain('第 2 处');
});

it('the composer annotation list uses the same file quote order as the sent message and candidate', async () => {
  await act(async () => root.render(<ContextAttachmentList attachments={quotes} compact />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="context-annotations-summary"]')?.click(),
  );
  expect(container.querySelector('[data-testid="context-annotation-item-first"]')?.textContent).toContain('第 1 处');
  expect(container.querySelector('[data-testid="context-annotation-item-second"]')?.textContent).toContain('第 2 处');
});
