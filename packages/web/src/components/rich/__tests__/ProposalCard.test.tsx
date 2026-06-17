import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { ProposalCard } from '../ProposalCard';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: vi.fn(),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('span', null, content),
}));
vi.mock('@/stores/chatStore', () => {
  const useChatStore = Object.assign(
    vi.fn(() => [] as string[]),
    {
      getState: () => ({ threads: [], updateThreadPin: vi.fn() }),
    },
  );
  return { useChatStore };
});

Object.assign(globalThis as Record<string, unknown>, { React });

// project ownership uses an absolute path → isDefaultProjectOwnership=false → no needs-choice branch
const baseBlock: RichCardBlock = {
  id: 'proposal-p1',
  kind: 'card',
  v: 1,
  title: '📥 提议新建 thread：通知卡片猫猫化',
  bodyMarkdown: '想开个独立 thread 推进富文本 SVG 化。',
  tone: 'info',
  fields: [
    { label: '父 Thread', value: 'thread_x' },
    { label: '建议成员', value: '@gemini25' },
    { label: '回报模式', value: 'autonomous（无强制回报）' },
    { label: '项目归属', value: '/home/user/cat-cafe' },
  ],
  actions: [
    { label: '批准并创建', action: 'propose:approve', payload: { proposalId: 'p1' } },
    { label: '驳回', action: 'propose:reject', payload: { proposalId: 'p1' } },
  ],
};

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('ProposalCard (F225 猫猫化 — emoji → CafeIcon SVG)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(async () => okJson({ proposal: { status: 'pending' } }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('strips the 📥 title prefix and renders an SVG title icon instead', async () => {
    await act(async () => {
      root.render(<ProposalCard block={baseBlock} />);
    });
    expect(container.textContent).toContain('提议新建 thread：通知卡片猫猫化');
    expect(container.textContent).not.toContain('📥');
    const icon = container.querySelector('[data-testid="proposal-card-icon"]');
    expect(icon).not.toBeNull();
    expect(icon?.querySelector('svg')).not.toBeNull();
  });

  it('keeps showing the title for a post-migration block with no 📥 prefix', async () => {
    const cleanBlock: RichCardBlock = { ...baseBlock, title: '提议新建 thread：通知卡片猫猫化' };
    await act(async () => {
      root.render(<ProposalCard block={cleanBlock} />);
    });
    expect(container.textContent).toContain('提议新建 thread：通知卡片猫猫化');
  });

  it('renders the pin-on-approve option with a pin SVG, not 📌', async () => {
    await act(async () => {
      root.render(<ProposalCard block={baseBlock} />);
    });
    expect(container.textContent).toContain('置顶新 thread');
    expect(container.textContent).not.toContain('📌');
    const pinLabel = [...container.querySelectorAll('label')].find((l) => l.textContent?.includes('置顶新 thread'));
    expect(pinLabel?.querySelector('svg')).not.toBeNull();
  });

  it('approved state shows a check SVG, not the ✓ glyph', async () => {
    vi.mocked(apiFetch).mockImplementation(async () =>
      okJson({ proposal: { status: 'approved', createdThreadId: 'thread_new' } }),
    );
    await act(async () => {
      root.render(<ProposalCard block={baseBlock} />);
    });
    expect(container.textContent).toContain('已批准');
    expect(container.textContent).not.toContain('✓');
  });

  it('rejected state shows a cross SVG, not the ✗ glyph', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => okJson({ proposal: { status: 'rejected' } }));
    await act(async () => {
      root.render(<ProposalCard block={baseBlock} />);
    });
    expect(container.textContent).toContain('已驳回');
    expect(container.textContent).not.toContain('✗');
  });

  // gpt52 P1: 后端去掉 📥 后，edit 初始化的剥离正则必须兼容无 emoji 的新格式，
  // 否则 edit→approve 会把「提议新建 thread：」前缀写进真实 thread title（covers the edit/approve path）.
  it('edit-then-approve sends the bare thread title without the 提议新建 thread： prefix (post-📥-removal)', async () => {
    const newBlock: RichCardBlock = { ...baseBlock, title: '提议新建 thread：通知卡片猫猫化' };
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse((init.body as string) || '{}') as Record<string, unknown> });
        return okJson({ threadId: 'thread_new' });
      }
      return okJson({ proposal: { status: 'pending' } });
    });
    await act(async () => {
      root.render(<ProposalCard block={newBlock} />);
    });
    const editBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '编辑');
    await act(async () => {
      editBtn?.click();
    });
    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('批准'));
    await act(async () => {
      approveBtn?.click();
    });
    const approveCall = posts.find((p) => p.url.includes('/approve'));
    expect(approveCall).toBeDefined();
    expect(approveCall?.body.title).toBe('通知卡片猫猫化');
  });
});
