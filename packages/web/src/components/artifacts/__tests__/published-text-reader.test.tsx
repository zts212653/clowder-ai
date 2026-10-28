import { QuoteContextAttachmentSchema, type ThreadArtifactDTO } from '@cat-cafe/shared';
import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkShellCopyParity } from '@/components/shell/__tests__/shell-copy-parity-check';
import { publishedTextCopy } from '@/components/workspace/published-text.shell-copy';
import { useArtifactContent } from '@/hooks/useArtifactContent';
import { ArtifactDetailView } from '../ArtifactDetailView';

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: '', apiFetch: (...args: unknown[]) => fixture.fetch(...args) }));
vi.mock('@/components/workspace/CodeViewer', () => ({
  CodeViewer: ({ content }: { content: string }) => <pre data-testid="source-text">{content}</pre>,
}));
const artifact: ThreadArtifactDTO = {
  type: 'file',
  name: 'published.md',
  url: '/uploads/doc-original-published.md',
  catId: 'codex61-sol',
  createdAt: 41,
  sourceMessageId: 'document-message',
  publicationItem: { kind: 'rich-file', blockId: 'document-file' },
};
const container = document.createElement('div');
const root = createRoot(container);

it('the published reader labels satisfy the canonical Chinese and English copy contract', () => {
  expect(checkShellCopyParity(publishedTextCopy)).toEqual([]);
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.fetch.mockReset();
});
afterEach(() => {
  act(() => root.render(null));
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('a published Markdown copy uses the original reader and source controls without workspace write actions', async () => {
  fixture.fetch.mockResolvedValue({ ok: true, text: async () => '# Published\n\nOriginal words.\n' });
  const back = vi.fn();
  await act(async () =>
    root.render(<ArtifactDetailView artifact={artifact} worktreeId={null} onBack={back} onJump={() => undefined} />),
  );
  const reader = container.querySelector('[data-testid="workspace-file-viewer"]');
  expect(reader).not.toBeNull();
  expect(reader?.textContent).toContain('Original words.');
  expect(reader?.textContent).toContain('只读');
  const source = [...container.querySelectorAll('button')].find((button) => button.textContent === '源码');
  expect(source).toBeDefined();
  act(() => source?.click());
  expect(container.querySelector('[data-testid="workspace-file-viewer"]')).toBe(reader);
  expect(container.querySelector('[data-testid="source-text"]')?.textContent).toContain('Original words.');
  expect(
    [...container.querySelectorAll('button')].some((button) =>
      /编辑|采用并写回|请猫修改/.test(button.textContent ?? ''),
    ),
  ).toBe(false);
  expect(fixture.fetch.mock.calls[0][0]).toBe(artifact.url);
  expect(fixture.fetch.mock.calls.slice(1).every(([url]) => String(url).startsWith('/api/tts/listen/document?'))).toBe(
    true,
  );
  act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === '返回来源')?.click());
  expect(back).toHaveBeenCalledTimes(1);
});

it('a published selection preserves its exact original message and file item as a message quote', () => {
  const parsed = QuoteContextAttachmentSchema.safeParse({
    v: 1,
    id: 'selected-published-words',
    kind: 'quote',
    text: 'Original words.',
    source: {
      kind: 'message',
      threadId: 'original-thread',
      messageId: 'document-message',
      artifactFile: {
        item: artifact.publicationItem,
        url: artifact.url,
        fileName: artifact.name,
        messageRevision: '41',
        displayDigest: `sha256:${'a'.repeat(64)}`,
      },
    },
  });
  expect(parsed.success).toBe(true);
  if (parsed.success)
    expect(parsed.data.source).toMatchObject({ kind: 'message', artifactFile: { item: artifact.publicationItem } });
});

it('a published document has the common file menu while its text keeps native context selection', async () => {
  fixture.fetch.mockImplementation(async (url: string) =>
    url.includes('file-info')
      ? { ok: true, json: async () => ({ local: true, path: '/uploads/copy.md', mime: 'text/markdown' }) }
      : { ok: true, text: async () => '# Published\n\nOriginal words.\n' },
  );
  await act(async () =>
    root.render(
      <ArtifactDetailView artifact={artifact} worktreeId={null} onBack={() => undefined} onJump={() => undefined} />,
    ),
  );
  const body = container.querySelector('[data-testid="workspace-file-viewer"] p');
  expect(body?.textContent).toBe('Original words.');
  const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  act(() => body?.dispatchEvent(context));
  expect(context.defaultPrevented).toBe(false);
  const more = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  expect(more, 'read-only copies must expose the same file menu as ordinary Workspace documents').not.toBeNull();
  await act(async () => more?.click());
  expect(container.textContent).toContain('在 Finder 中显示');
  expect(container.textContent).toContain('复制路径');
  expect(container.querySelectorAll('button[aria-haspopup="menu"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-testid="content-file-toolbar"]')).toHaveLength(1);
});

it('switching identical file names cannot show the previous body under the new artifact even before its fetch effect', async () => {
  const observed: { url: string | undefined; content: string | null }[] = [];
  function Observe({ target }: { target: ThreadArtifactDTO }) {
    const state = useArtifactContent(target, null, true);
    useLayoutEffect(() => {
      observed.push({ url: target.url, content: state.content });
    });
    return <div>{state.content}</div>;
  }
  fixture.fetch.mockResolvedValueOnce({ ok: true, text: async () => 'first document body' });
  await act(async () => root.render(<Observe target={artifact} />));
  expect(container.textContent).toBe('first document body');
  fixture.fetch.mockReturnValueOnce(new Promise(() => undefined));
  const next = { ...artifact, url: '/uploads/doc-second-published.md', sourceMessageId: 'second-message' };
  await act(async () => root.render(<Observe target={next} />));
  expect(observed.filter((item) => item.url === next.url).every((item) => item.content === null)).toBe(true);
});
