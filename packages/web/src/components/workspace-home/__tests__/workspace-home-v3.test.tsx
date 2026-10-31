import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { artifactObjectId } from '@/components/workbench/real-surface-adapters';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceHomeV2 } from '../WorkspaceHomeV2';
import { command, live, NOW, seed } from './home-fixtures';

const data = vi.hoisted(() => ({
  artifacts: [] as ThreadArtifactDTO[],
  loading: false,
  error: false,
  refetch: vi.fn(),
}));
vi.mock('@/hooks/useThreadArtifacts', () => ({
  useThreadArtifacts: () => ({ ...data, works: data.artifacts, total: data.artifacts.length, complete: true }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => ({ id, displayName: id, color: { primary: 'var(--color-codex-primary)' } }),
  }),
}));
vi.mock('@/hooks/useDeploymentWaitProjection', () => ({
  useDeploymentWaitProjection: () => ({ projection: null, hydration: 'ready', retry: vi.fn() }),
}));
vi.mock('@/hooks/useActiveExecutionProjection', () => ({ cancelProjectedExecution: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: '',
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [] }) })),
}));

const imageArtifact: ThreadArtifactDTO = {
  type: 'image',
  name: '这一件精确图片',
  catId: 'codex61-sol',
  createdAt: NOW,
  sourceMessageId: 'source-message-exact',
  url: '/uploads/exact.png',
  publicationItem: { kind: 'content-block', index: 0 },
};
const props = {
  threadId: 'thread-here',
  defaultCatId: 'codex61-sol',
  worktreeId: null,
  destinationMessage: null,
  onSelectDevSurface: vi.fn(),
  onSelectDestination: vi.fn(),
  onSelectExecution: vi.fn(),
};
describe('Workspace v3 Home content', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    writeShellLanguage('zh');
    data.loading = false;
    data.error = false;
    data.refetch.mockReset();
    useChatStore.setState({
      currentThreadId: 'thread-here',
      threadStates: {},
      messages: [],
      catInvocations: {},
      catStatuses: {},
      catStatusDetails: {},
      activeInvocations: {},
      hasActiveInvocation: false,
      targetCats: [],
      threads: [
        {
          id: 'thread-here',
          title: '完整的当前对话名称',
          projectPath: '/project',
          createdBy: 'user',
          createdAt: 1,
          lastActiveAt: 1,
          participants: [],
        },
      ],
    });
    data.artifacts = [
      imageArtifact,
      {
        type: 'pr',
        name: '真实变更',
        ref: 'org/repo#42',
        catId: 'codex61-sol',
        createdAt: NOW - 1000,
        sourceMessageId: null,
      },
    ];
    seed([
      live('codex61-sol', 'thread-here', '当前对话', 'live-1'),
      command('codex61-sol', 'thread-here', 'hold-1', 'test', NOW - 1000),
      ...Array.from({ length: 18 }, (_, index) =>
        live('codex61-sol', `thread-${index}`, `并行对话 ${index}`, `live-${index + 2}`),
      ),
    ]);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render() {
    await act(async () => root.render(<WorkspaceHomeV2 {...props} />));
  }
  it('shows all 20 executions as 20 rows, including two executions from the same cat/conversation', async () => {
    await render();
    expect(host.querySelectorAll('[data-testid="workspace-running-object"]')).toHaveLength(20);
    expect(host.querySelector('[data-testid="workspace-running-here"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="workspace-running-activity"]')).toHaveLength(0);
  });
  it('has three content sections and moves tool search off the Home', async () => {
    await render();
    expect([...host.querySelectorAll('h2')].map((node) => node.textContent)).toEqual([
      '正在发生',
      '状态与会话',
      '作品',
    ]);
    expect(host.querySelector('[data-testid="workspace-launcher-home"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="workspace-home-status-summary"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="workspace-home-artifact-card"] img')?.getAttribute('src')).toBe(
      imageArtifact.url,
    );
  });
  it('anchors the conversation sections with icons and shows the conversation title once above them', async () => {
    await render();
    expect(host.querySelector('[data-testid="home-conversation-scope"]')?.textContent).toBe(
      '这条对话完整的当前对话名称',
    );
    const sections = [...host.querySelectorAll('section[aria-labelledby]')];
    expect(
      sections
        .find((section) => section.getAttribute('aria-labelledby') === 'home-status-title')
        ?.querySelector('header svg'),
    ).not.toBeNull();
    const works = sections.find((section) => section.getAttribute('aria-labelledby') === 'home-works-title');
    expect(works?.querySelector('header svg')).not.toBeNull();
    expect(works?.querySelector('header')?.textContent).toContain('2 件');
    expect(works?.querySelector('header')?.textContent).not.toContain('这条对话');
    data.loading = true;
    await render();
    expect(works?.querySelector('header')?.textContent).toContain('2 件');
    expect(host.querySelector('[data-testid="workspace-home-status-summary"] .home-live-sub')).not.toBeNull();
  });

  it('produces the status owner title in the current language while keeping the canonical destination', async () => {
    writeShellLanguage('en');
    props.onSelectDestination.mockClear();
    await render();
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-status-summary"]')?.click());
    expect(props.onSelectDestination).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'host', id: 'status', label: 'Status & sessions' }),
    );
  });
  it('opens the exact picture in a local lightbox and Esc returns to the same card', async () => {
    await render();
    const card = host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]');
    expect(card).not.toBeNull();
    await act(async () => card?.click());
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(imageArtifact.url);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(card);
  });
  it('returns focus to the exact replacement card after a pending catalogue refresh', async () => {
    await render();
    const original = host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]');
    await act(async () => original?.click());
    data.loading = true;
    await render();
    expect(original?.isConnected).toBe(false);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    data.loading = false;
    data.artifacts = [...data.artifacts.slice(1), { ...imageArtifact }];
    await render();
    const replacement = [...host.querySelectorAll<HTMLButtonElement>('[data-home-artifact-id]')].find(
      (node) => node.getAttribute('data-home-artifact-id') === artifactObjectId(imageArtifact),
    );
    expect(replacement).not.toBe(original);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(replacement);
    expect(replacement?.getAttribute('data-home-artifact-id')).toBe(artifactObjectId(imageArtifact));
  });
  it('leaves focus with the original annotation owner when that owner takes it', async () => {
    const readerControl = document.createElement('button');
    readerControl.textContent = 'Original owner reader control';
    document.body.append(readerControl);
    try {
      await act(async () => root.render(<WorkspaceHomeV2 {...props} onOpenArtifact={() => readerControl.focus()} />));
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]')?.click(),
      );
      const annotate = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (button) => button.textContent === '批注',
      );
      await act(async () => annotate?.click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(readerControl);
    } finally {
      readerControl.remove();
    }
  });
  it('keeps the exact local preview entry when three new works displace it from the Home summary', async () => {
    await render();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]')?.click(),
    );
    data.loading = true;
    await render();
    data.artifacts = [
      ...Array.from({ length: 3 }, (_, index) => ({
        ...imageArtifact,
        name: `New publication ${index}`,
        sourceMessageId: `new-${index}`,
        url: `/uploads/new-${index}.png`,
        createdAt: NOW + (3 - index) * 1000,
      })),
      imageArtifact,
    ];
    data.loading = false;
    await render();
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(imageArtifact.url);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    const returned = [...host.querySelectorAll<HTMLButtonElement>('[data-home-artifact-id]')].find(
      (node) => node.getAttribute('data-home-artifact-id') === artifactObjectId(imageArtifact),
    );
    expect(returned).toBeDefined();
    expect(document.activeElement).toBe(returned);
    expect(host.querySelectorAll('[data-home-artifact-id]')).toHaveLength(3);
    expect(host.textContent).not.toContain('无法打开这件作品');
  });
  it.each([
    'distinct',
    'identical',
  ] as const)('retains exact reader return and local preview entries when their keys are %s', async (keys) => {
    const readerReturn =
      keys === 'identical'
        ? imageArtifact
        : { ...imageArtifact, name: 'Reader return', sourceMessageId: 'reader-return', url: '/uploads/reader.png' };
    data.artifacts = keys === 'identical' ? [imageArtifact] : [imageArtifact, readerReturn];
    const returnArtifactId = artifactObjectId(readerReturn);
    const renderReturnedHome = () =>
      act(async () => root.render(<WorkspaceHomeV2 {...props} returnArtifactId={returnArtifactId} />));
    await renderReturnedHome();
    const entryCard = [...host.querySelectorAll<HTMLButtonElement>('[data-home-artifact-id]')].find(
      (card) => card.getAttribute('data-home-artifact-id') === artifactObjectId(imageArtifact),
    );
    await act(async () => entryCard?.click());
    data.loading = true;
    await renderReturnedHome();
    expect(entryCard?.isConnected).toBe(false);
    data.artifacts = [
      ...Array.from({ length: 3 }, (_, index) => ({
        ...imageArtifact,
        name: `New image ${index}`,
        sourceMessageId: `new-image-${index}`,
        url: `/uploads/new-image-${index}.png`,
      })),
      ...data.artifacts,
    ];
    data.loading = false;
    await renderReturnedHome();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    const cards = [...host.querySelectorAll<HTMLButtonElement>('[data-home-artifact-id]')];
    const ids = cards.map((card) => card.getAttribute('data-home-artifact-id'));
    expect(ids).toContain(returnArtifactId);
    expect(ids).toContain(artifactObjectId(imageArtifact));
    expect(new Set(ids).size).toBe(3);
    expect(cards).toHaveLength(3);
    expect(document.activeElement).toBe(
      cards.find((card) => card.getAttribute('data-home-artifact-id') === artifactObjectId(imageArtifact)),
    );
    expect(host.querySelector('[data-home-artifact-return]')?.getAttribute('data-home-artifact-return')).toBe('ready');
  });
  it('keeps dialog focus when new publications disable the focused Next control without changing the selected image', async () => {
    data.artifacts = [
      imageArtifact,
      { ...imageArtifact, name: 'Second image', sourceMessageId: 'second', url: '/uploads/second.png' },
    ];
    await render();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]')?.click(),
    );
    const next = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="下一张"]');
    next?.focus();
    data.artifacts = [
      ...Array.from({ length: 3 }, (_, index) => ({
        ...imageArtifact,
        name: `Recent image ${index}`,
        sourceMessageId: `recent-${index}`,
        url: `/uploads/recent-${index}.png`,
      })),
      ...data.artifacts,
    ];
    await render();
    expect(next?.disabled).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"] button[aria-label="关闭预览"]'));
  });
  it('keeps focus on an enabled lightbox control when either paging button reaches its boundary', async () => {
    // JSDOM has no CSS.escape; these literal escapes support the test's exact card attribute selector.
    vi.stubGlobal('CSS', {
      escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`),
    });
    data.artifacts = [
      imageArtifact,
      { ...imageArtifact, name: '第二张', sourceMessageId: 'second-source', url: '/uploads/second.png' },
    ];
    await render();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]')?.click(),
    );
    const next = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="下一张"]');
    next?.focus();
    await act(async () => next?.click());
    expect(next?.disabled).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"] button[aria-label="关闭预览"]'));
    const previous = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="上一张"]');
    previous?.focus();
    await act(async () => previous?.click());
    expect(previous?.disabled).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"] button[aria-label="关闭预览"]'));
  });
  it('does not take focus from another owner when a catalogue refresh disables the previous dialog control', async () => {
    const ownerControl = document.createElement('button');
    document.body.append(ownerControl);
    try {
      data.artifacts = [
        imageArtifact,
        { ...imageArtifact, name: 'Second image', sourceMessageId: 'second', url: '/uploads/second.png' },
      ];
      await render();
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]')?.click(),
      );
      const next = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="下一张"]');
      next?.focus();
      ownerControl.focus();
      data.artifacts = [
        ...Array.from({ length: 3 }, (_, index) => ({
          ...imageArtifact,
          name: `New publication ${index}`,
          sourceMessageId: `new-${index}`,
          url: `/uploads/new-${index}.png`,
        })),
        ...data.artifacts,
      ];
      await render();
      expect(next?.disabled).toBe(true);
      expect(document.activeElement).toBe(ownerControl);
      await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(document.activeElement).toBe(ownerControl);
    } finally {
      ownerControl.remove();
    }
  });
  it('does not invent version numbers or PR status from list position', async () => {
    await render();
    expect(host.textContent).not.toMatch(/第\s*[12]\s*版|已合入/);
  });
  it('hands annotation the complete publication DTO and signed exact Home origin', async () => {
    const onOpenArtifact = vi.fn();
    await act(async () => root.render(<WorkspaceHomeV2 {...props} onOpenArtifact={onOpenArtifact} />));
    const card = host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]');
    const viewport = host.querySelector<HTMLDivElement>('[data-testid="f307-workspace-home-page"]');
    if (!card || !viewport) throw new Error('Original Home card and viewport are required');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 12, 288, 120));
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 34, 288, 480));
    await act(async () => card?.click());
    const annotate = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent === '批注',
    );
    expect(annotate).toBeDefined();
    await act(async () => annotate?.click());
    expect(onOpenArtifact).toHaveBeenCalledWith(imageArtifact, {
      kind: 'workspace-home-artifact',
      threadId: props.threadId,
      artifactId: artifactObjectId(imageArtifact),
      viewportOffsetPx: -22,
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('keeps the exact return card visible when newer publications push it out of the first three', async () => {
    const older = {
      ...imageArtifact,
      name: '原来的第三张',
      sourceMessageId: 'old-exact-source',
      url: '/uploads/old.png',
    };
    data.artifacts = [
      ...data.artifacts,
      { ...imageArtifact, name: '新来的图片', sourceMessageId: 'new-source', url: '/uploads/new.png' },
      older,
    ];
    const returnArtifactId = artifactObjectId(older);
    await act(async () => root.render(<WorkspaceHomeV2 {...props} {...{ returnArtifactId }} />));
    const returned = [...host.querySelectorAll('[data-home-artifact-id]')].find(
      (node) => node.getAttribute('data-home-artifact-id') === returnArtifactId,
    );
    expect(returned).toBeDefined();
    expect(returned?.getAttribute('aria-current')).toBe('true');
    expect(host.querySelectorAll('[data-home-artifact-id]')).toHaveLength(3);
  });
  it('reports an exact missing return key without selecting the first work', async () => {
    await act(async () => root.render(<WorkspaceHomeV2 {...props} {...{ returnArtifactId: 'missing-exact-key' }} />));
    expect(host.querySelector('[data-home-artifact-return]')?.getAttribute('data-home-artifact-return')).toBe(
      'unavailable',
    );
    expect(host.querySelector('[aria-current="true"]')).toBeNull();
  });
  it('keeps an exact return pending until its fresh catalogue finishes loading', async () => {
    data.loading = true;
    data.artifacts = [];
    await act(async () =>
      root.render(<WorkspaceHomeV2 {...props} returnArtifactId={artifactObjectId(imageArtifact)} />),
    );
    expect(host.querySelector('[data-home-artifact-return]')?.getAttribute('data-home-artifact-return')).toBe(
      'pending',
    );
    expect(host.textContent).not.toContain('无法打开这件作品');
    data.loading = false;
    data.artifacts = [imageArtifact];
    await act(async () =>
      root.render(<WorkspaceHomeV2 {...props} returnArtifactId={artifactObjectId(imageArtifact)} />),
    );
    expect(host.querySelector('[data-home-artifact-return]')?.getAttribute('data-home-artifact-return')).toBe('ready');
    expect(host.querySelector('[aria-current="true"]')?.getAttribute('data-home-artifact-id')).toBe(
      artifactObjectId(imageArtifact),
    );
  });
  it('reports a failed fresh catalogue without treating a retained card as a successful return', async () => {
    data.error = true;
    await act(async () =>
      root.render(<WorkspaceHomeV2 {...props} returnArtifactId={artifactObjectId(imageArtifact)} />),
    );
    expect(host.querySelector('[data-home-artifact-return]')?.getAttribute('data-home-artifact-return')).toBe(
      'unavailable',
    );
    expect(host.querySelector('[aria-current="true"]')).toBeNull();
  });
});
