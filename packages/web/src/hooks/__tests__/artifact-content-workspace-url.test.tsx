import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act, type ReactNode, useLayoutEffect, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactFileReader } from '@/components/artifacts/ArtifactFileReader';
import { WorkPaperPreview } from '@/components/artifacts/WorkPaperPreview';
import { useArtifactContent } from '@/hooks/useArtifactContent';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://test.local', apiFetch: vi.fn() }));
vi.mock('@/components/artifacts/useNearWorkViewport', () => ({
  useNearWorkViewport: () => ({ ref: { current: null }, near: true }),
}));
// Observe the actual catalogue adapter's read result; the common renderer is unchanged here.
vi.mock('@/components/artifacts/PublishedTextReader', () => ({
  PublishedTextReader: ({ content, source }: { content: string; source: { kind: string; worktreeId?: string } }) => (
    <p data-reader-body data-source-kind={source.kind} data-source-tree={source.worktreeId}>
      {content}
    </p>
  ),
}));

const sourceTree = 'cat-cafe-alpha-f309-prepared-parent-astra';
const sourcePath = '.cat-cafe/uploads/1793158681584-c0592a89.md';
const raw = `/api/workspace/file/raw?worktreeId=${sourceTree}&path=${encodeURIComponent(sourcePath)}`;
const read = `/api/workspace/file?worktreeId=${sourceTree}&path=${encodeURIComponent(sourcePath)}`;
const body = '# Prepared raw 同源验收\n\n这是 Schedule 和 Needs Me 的同一份中文 Markdown。\n';
const artifact = (url = raw): ThreadArtifactDTO => ({
  type: 'file',
  name: 'prepared.md',
  url,
  createdAt: 1,
  catId: null,
  sourceMessageId: null,
});

function Probe({ url, ambient }: { url: string; ambient: string | null }) {
  const input = useMemo(() => artifact(url), [url]);
  const state = useArtifactContent(input, ambient, true);
  return <output data-error={String(state.error)}>{state.content}</output>;
}

describe('workspace URL content reads preserve their source owner', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(
      async (url) =>
        ({
          ok: String(url) === read,
          status: String(url) === read ? 200 : 400,
          json: async () => ({ content: body, binary: false, mime: 'text/markdown' }),
          text: async () => 'raw is media-only',
        }) as Response,
    );
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(element: ReactNode) {
    await act(async () => root.render(element));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it.each([
    null,
    'unrelated-worktree',
    sourceTree,
  ])('reads a relative raw URL using its owner, ambient=%s', async (ambient) => {
    await render(<Probe url={raw} ambient={ambient} />);
    expect(host.querySelector('output')?.textContent).toBe(body);
    expect(host.querySelector('output')?.getAttribute('data-error')).toBe('false');
    expect(apiFetch).toHaveBeenCalledWith(read);
    expect(apiFetch).not.toHaveBeenCalledWith(raw);
  });

  it.each(['http://test.local', ''])('the existing source parser also handles %s download URLs', async (origin) => {
    const url = origin + raw.replace('/raw?', '/download?');
    await render(<Probe url={url} ambient="unrelated-worktree" />);
    expect(host.querySelector('output')?.textContent).toBe(body);
    expect(apiFetch).toHaveBeenCalledWith(read);
  });

  it('the actual paper cover renders the source text rather than placeholder bars', async () => {
    await render(<WorkPaperPreview kind="document" artifact={artifact()} />);
    expect(host.querySelector('strong')?.textContent).toBe('Prepared raw 同源验收');
    expect(host.querySelector('.work-cover-excerpt')?.textContent).toContain('Schedule 和 Needs Me');
    expect(host.querySelector('.work-cover-bar')).toBeNull();
  });

  it('the actual ArtifactFileReader hands the same source text to its renderer', async () => {
    await render(
      <ArtifactFileReader artifact={artifact()} worktreeId="unrelated-worktree" onBack={vi.fn()} onJump={vi.fn()} />,
    );
    expect(host.querySelector('[data-reader-body]')?.textContent).toBe(body);
    expect(host.querySelector('[data-reader-body]')?.getAttribute('data-source-kind')).toBe('workspace');
    expect(host.querySelector('[data-reader-body]')?.getAttribute('data-source-tree')).toBe(sourceTree);
    expect(apiFetch).toHaveBeenCalledWith(read);
  });

  it('a denied owner read stays failed without retrying another worktree', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 403 } as Response);
    await render(<Probe url={raw} ambient="unrelated-worktree" />);
    expect(host.querySelector('output')?.getAttribute('data-error')).toBe('true');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith(read);
  });

  it.each([
    `${raw}&extra=1`,
    `${raw}&path=other.md`,
  ])('malformed raw input retains the original rejected transport: %s', async (url) => {
    await render(<Probe url={url} ambient="unrelated-worktree" />);
    expect(host.querySelector('output')?.getAttribute('data-error')).toBe('true');
    expect(apiFetch).toHaveBeenCalledWith(url);
    expect(apiFetch).not.toHaveBeenCalledWith(read);
  });

  it('a foreign raw-shaped URL uses bare fetch and never the authenticated API client', async () => {
    const url = `https://foreign.example${raw}`;
    const fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => 'foreign text' });
    vi.stubGlobal('fetch', fetch);
    await render(<Probe url={url} ambient="unrelated-worktree" />);
    expect(host.querySelector('output')?.textContent).toBe('foreign text');
    expect(fetch).toHaveBeenCalledWith(url);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each([
    'success',
    'failure',
  ] as const)('a late previous %s cannot replace the current source body', async (outcome) => {
    let finish!: (value: Response | PromiseLike<Response>) => void;
    let fail!: (error: Error) => void;
    vi.mocked(apiFetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    await render(<Probe url={raw} ambient={null} />);
    const next = raw.replace('1793158681584-c0592a89.md', 'next.md');
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ content: 'current body' }) } as Response);
    await render(<Probe url={next} ambient={null} />);
    expect(host.querySelector('output')?.textContent).toBe('current body');
    await act(async () => {
      if (outcome === 'success') finish({ ok: true, json: async () => ({ content: 'old body' }) } as Response);
      else fail(new Error('old source failed'));
    });
    expect(host.querySelector('output')?.textContent).toBe('current body');
    expect(host.querySelector('output')?.getAttribute('data-error')).toBe('false');
  });

  it('a changed ambient owner cannot display the old repo body for even the first frame', async () => {
    const target = { ...artifact(), url: undefined, ref: 'docs/a.md' };
    const frames: { tree: string; content: string | null }[] = [];
    function Observe({ tree }: { tree: string }) {
      const state = useArtifactContent(target, tree, true);
      useLayoutEffect(() => {
        frames.push({ tree, content: state.content });
      });
      return <output>{state.content}</output>;
    }
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, json: async () => ({ content: 'old owner' }) } as Response);
    await render(<Observe tree="first-tree" />);
    expect(host.textContent).toBe('old owner');
    vi.mocked(apiFetch).mockReturnValueOnce(new Promise(() => undefined));
    await render(<Observe tree="next-tree" />);
    expect(frames.filter((frame) => frame.tree === 'next-tree').every((frame) => frame.content === null)).toBe(true);
  });
});
