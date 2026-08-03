import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const LONG_ARTIFACT_NAME = 'docs/features/assets/F269/一份非常长而且必须能够复制完整值的产物审计报告-final-reviewed.md';
const LONG_BINARY_NAME = 'exports/F269/一份非常长而且必须能够复制完整值的产物审计证据归档-final-reviewed.zip';
const LONG_THREAD_TITLE = 'F269 全前端长文本恢复审计与生产迁移的超长对话标题';

const { state } = vi.hoisted(() => ({
  state: {
    threadArtifacts: [] as Array<Record<string, unknown>>,
    globalArtifacts: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://test.local', apiFetch: vi.fn() }));
vi.mock('@/hooks/useThreadArtifacts', () => ({
  useThreadArtifacts: () => ({ artifacts: state.threadArtifacts, loading: false, error: null }),
}));
vi.mock('@/hooks/useGlobalArtifacts', () => ({
  useGlobalArtifacts: (enabled: boolean) => ({
    artifacts: enabled ? state.globalArtifacts : [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: () => ({ displayName: '缅因猫', variantLabel: 'Sol', nickname: '砚砚' }),
  }),
}));

import { useChatStore } from '@/stores/chatStore';
import { ArtifactsPanel } from '../ArtifactsPanel';
import { ArtifactDetailView } from '../artifacts/ArtifactDetailView';

function setInlineOverflow(element: Element) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: 100 },
    scrollWidth: { configurable: true, value: 800 },
  });
}

async function measureOverflow(element: Element) {
  setInlineOverflow(element);
  await act(async () => window.dispatchEvent(new Event('resize')));
}

function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

function measuredValue(container: ParentNode, value: string): HTMLElement {
  const match = Array.from(container.querySelectorAll<HTMLElement>('[data-overflow-measure="inline"]')).find(
    (element) => element.textContent === value,
  );
  expect(match, `expected a measured compact label for ${value}`).toBeTruthy();
  if (!match) throw new Error(`Missing measured compact label for ${value}`);
  return match;
}

describe('F269 artifact compact-label recovery', () => {
  let roots: Root[] = [];
  let writeText: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    useChatStore.setState({ currentThreadId: 'T-current', workspaceWorktreeId: null });
    state.threadArtifacts = [];
    state.globalArtifacts = [];
    roots = [];
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('recovers a long row name without activating the parent artifact row', async () => {
    state.threadArtifacts = [
      {
        type: 'file',
        name: LONG_ARTIFACT_NAME,
        catId: 'codex-sol',
        createdAt: Date.now(),
        sourceMessageId: 'msg-1',
        url: '/uploads/report.md',
      },
    ];
    const { container, root } = render(createElement(ArtifactsPanel, { threadId: 'T-current' }));
    roots.push(root);

    await measureOverflow(measuredValue(container, LONG_ARTIFACT_NAME));
    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="复制完整产物名称"]');
    expect(copy).toBeTruthy();

    await act(async () => copy?.click());

    expect(writeText).toHaveBeenCalledWith(LONG_ARTIFACT_NAME);
    expect(container.querySelector('button[aria-label="返回"]')).toBeNull();
  });

  it('keeps group collapse and full-label recovery as sibling actions', async () => {
    state.globalArtifacts = [
      {
        type: 'file',
        name: LONG_ARTIFACT_NAME,
        catId: 'codex-sol',
        createdAt: Date.now(),
        sourceMessageId: 'msg-2',
        threadId: 'T-other',
        threadTitle: LONG_THREAD_TITLE,
      },
    ];
    const { container, root } = render(createElement(ArtifactsPanel, { threadId: 'T-current' }));
    roots.push(root);

    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === '全局')
        ?.click();
    });
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === '对话')
        ?.click();
    });

    const header = container.querySelector<HTMLElement>('[data-artifact-group-header]');
    expect(header).toBeTruthy();
    if (!header) throw new Error('Missing artifact group header');
    await measureOverflow(measuredValue(header, LONG_THREAD_TITLE));

    const collapse = header.querySelector<HTMLButtonElement>('button[aria-expanded="true"]');
    const copy = header.querySelector<HTMLButtonElement>('button[aria-label="复制完整分组名称"]');
    expect(collapse).toBeTruthy();
    expect(copy).toBeTruthy();
    expect(collapse?.contains(copy ?? null)).toBe(false);

    act(() => measuredValue(header, LONG_THREAD_TITLE).click());
    expect(container.querySelector('[data-artifact-row]')).toBeNull();
    act(() => measuredValue(header, LONG_THREAD_TITLE).click());
    expect(container.querySelector('[data-artifact-row]')).toBeTruthy();

    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith(LONG_THREAD_TITLE);
    expect(container.querySelector('[data-artifact-row]')).toBeTruthy();

    act(() => collapse?.click());
    expect(container.querySelector('[data-artifact-row]')).toBeNull();
  });

  it('recovers long names in the detail header and download body', async () => {
    const { container, root } = render(
      createElement(ArtifactDetailView, {
        artifact: {
          type: 'file',
          name: LONG_BINARY_NAME,
          catId: null,
          createdAt: 1,
          sourceMessageId: null,
          url: '/uploads/archive.zip',
        },
        worktreeId: null,
        onBack: vi.fn(),
        onJump: vi.fn(),
      }),
    );
    roots.push(root);

    const measured = Array.from(container.querySelectorAll<HTMLElement>('[data-overflow-measure="inline"]')).filter(
      (element) => element.textContent === LONG_BINARY_NAME,
    );
    expect(measured).toHaveLength(2);
    for (const element of measured) setInlineOverflow(element);
    await act(async () => window.dispatchEvent(new Event('resize')));

    expect(container.querySelectorAll('button[aria-label="复制完整产物名称"]')).toHaveLength(2);
    expect(container.querySelector(`[title="${LONG_BINARY_NAME}"]`)).toBeNull();
  });
});
