import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { FrustrationIssueCard } from '../FrustrationIssueCard';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

Object.assign(globalThis as Record<string, unknown>, { React });

const issueBlock = {
  id: 'f222-card',
  kind: 'card' as const,
  v: 1 as const,
  title: '🔍 我注意到刚才可能出了问题',
  bodyMarkdown: '**问题**: 模型工具调用解析失败',
  tone: 'warning' as const,
  meta: {
    kind: 'frustration_auto_issue',
    issueId: 'fi_test_status',
  },
};

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

function errorJson(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as Response;
}

describe('FrustrationIssueCard', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('hydrates confirmed status from the persisted issue after a page refresh', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      okJson({
        issue: {
          issueId: 'fi_test_status',
          status: 'confirmed',
          userDescription: 'Already submitted',
        },
      }),
    );

    await act(async () => {
      root.render(<FrustrationIssueCard block={issueBlock} />);
    });

    // UX-2: hydrated resolved state starts collapsed — badge visible, no action buttons
    await vi.waitFor(() => expect(container.textContent).toContain('已记录'));
    expect(container.textContent).not.toContain('确认记录');
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/frustration-issues/fi_test_status/status');
  });

  // F225 猫猫化: header icon 按 signalType 选 megaphone/search SVG（替代 🔍/📢 emoji）+ 剥离 title 前缀
  it('user_report card renders megaphone SVG and strips 📢', async () => {
    vi.mocked(apiFetch).mockResolvedValue(okJson({ issue: { issueId: 'fi_ur', status: 'draft' } }));
    const block = {
      ...issueBlock,
      title: '📢 你的问题反馈',
      meta: { kind: 'frustration_auto_issue', issueId: 'fi_ur', signalType: 'user_report' },
    };
    await act(async () => {
      root.render(<FrustrationIssueCard block={block} />);
    });
    expect(container.textContent).not.toContain('📢');
    expect(container.textContent).toContain('你的问题反馈');
    const d = container.querySelector('svg path')?.getAttribute('d') ?? '';
    expect(d).toContain('m3 11 18-5'); // megaphone signature
  });

  it('auto-detect card renders search SVG and strips 🔍', async () => {
    vi.mocked(apiFetch).mockResolvedValue(okJson({ issue: { issueId: 'fi_auto', status: 'draft' } }));
    const block = {
      ...issueBlock,
      title: '🔍 我注意到刚才可能出了问题',
      meta: { kind: 'frustration_auto_issue', issueId: 'fi_auto', signalType: 'cli_error' },
    };
    await act(async () => {
      root.render(<FrustrationIssueCard block={block} />);
    });
    expect(container.textContent).not.toContain('🔍');
    expect(container.textContent).toContain('我注意到刚才可能出了问题');
    const d = container.querySelector('svg path')?.getAttribute('d') ?? '';
    expect(d).toContain('M21 21l-6-6'); // search signature
  });

  it('ignores stale draft hydration after a local confirm action resolves', async () => {
    let resolveStatus!: (response: Response) => void;
    const statusPromise = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });

    vi.mocked(apiFetch).mockImplementation((url, init) => {
      const path = String(url);
      if (path.endsWith('/status')) {
        return statusPromise;
      }
      if (path.endsWith('/confirm') && init?.method === 'POST') {
        return Promise.resolve(okJson({ issue: { status: 'confirmed' } }));
      }
      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    await act(async () => {
      root.render(<FrustrationIssueCard block={issueBlock} />);
    });

    const confirmButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('确认记录'),
    );
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => expect(container.textContent).toContain('已记录'));
    expect(container.textContent).not.toContain('确认记录');

    await act(async () => {
      resolveStatus(okJson({ issue: { status: 'draft', userDescription: 'stale draft' } }));
      await statusPromise;
    });

    expect(container.textContent).toContain('已记录');
    expect(container.textContent).not.toContain('确认记录');
  });

  it('hydrates confirmed status after a duplicate confirm conflict resolves first', async () => {
    let resolveStatus!: (response: Response) => void;
    const statusPromise = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });

    vi.mocked(apiFetch).mockImplementation((url, init) => {
      const path = String(url);
      if (path.endsWith('/status')) {
        return statusPromise;
      }
      if (path.endsWith('/confirm') && init?.method === 'POST') {
        return Promise.resolve(errorJson(409, { error: 'Issue already confirmed' }));
      }
      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    await act(async () => {
      root.render(<FrustrationIssueCard block={issueBlock} />);
    });

    const confirmButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('确认记录'),
    );
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => expect(container.textContent).toContain('Issue already confirmed'));
    expect(container.textContent).toContain('确认记录');

    await act(async () => {
      resolveStatus(okJson({ issue: { status: 'confirmed', userDescription: 'Already submitted' } }));
      await statusPromise;
    });

    await vi.waitFor(() => expect(container.textContent).toContain('已记录'));
    expect(container.textContent).not.toContain('确认记录');
    expect(container.textContent).not.toContain('Issue already confirmed');
  });

  // ── UX-1: false positive button ────────────────────────────

  it('marks issue as false positive via the button', async () => {
    vi.mocked(apiFetch).mockImplementation((url, init) => {
      const path = String(url);
      if (path.endsWith('/status')) {
        return Promise.resolve(okJson({ issue: { status: 'draft' } }));
      }
      if (path.endsWith('/false-positive') && init?.method === 'POST') {
        return Promise.resolve(okJson({ issue: { status: 'false_positive' } }));
      }
      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    await act(async () => {
      root.render(<FrustrationIssueCard block={issueBlock} />);
    });

    const fpButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('误报'),
    );
    expect(fpButton).toBeTruthy();

    await act(async () => {
      fpButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => expect(container.textContent).toContain('误报'));
    expect(container.textContent).not.toContain('确认记录');
  });

  it('hydrates false_positive status from persisted issue', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      okJson({
        issue: {
          issueId: 'fi_test_status',
          status: 'false_positive',
        },
      }),
    );

    await act(async () => {
      root.render(<FrustrationIssueCard block={issueBlock} />);
    });

    await vi.waitFor(() => expect(container.textContent).toContain('误报'));
    expect(container.textContent).not.toContain('确认记录');
    expect(container.textContent).not.toContain('跳过');
  });

  // ── UX-2: collapse behavior ───────────────────────────────

  it('collapses to one-line summary after confirm action', async () => {
    vi.mocked(apiFetch).mockImplementation((url, init) => {
      const path = String(url);
      if (path.endsWith('/status')) {
        return Promise.resolve(okJson({ issue: { status: 'draft' } }));
      }
      if (path.endsWith('/confirm') && init?.method === 'POST') {
        return Promise.resolve(okJson({ issue: { status: 'confirmed' } }));
      }
      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    await act(async () => {
      root.render(<FrustrationIssueCard block={issueBlock} />);
    });

    const confirmButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('确认记录'),
    );
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // After confirm, card stays expanded (F235: "Publish to Community" button must be visible)
    await vi.waitFor(() => expect(container.textContent).toContain('已记录'));
    // Body remains visible — card is NOT collapsed after confirm (unlike skip/false_positive)
    expect(container.textContent).toContain('模型工具调用解析失败');
    // F235: Community publish flow should render
    expect(container.textContent).toContain('Publish to Community');
  });

  it('expands collapsed card on click', async () => {
    vi.mocked(apiFetch).mockImplementation((url, init) => {
      const path = String(url);
      if (path.endsWith('/status')) {
        return Promise.resolve(okJson({ issue: { status: 'draft' } }));
      }
      if (path.endsWith('/skip') && init?.method === 'POST') {
        return Promise.resolve(okJson({ issue: { status: 'skipped' } }));
      }
      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    await act(async () => {
      root.render(<FrustrationIssueCard block={issueBlock} />);
    });

    // Skip to trigger collapse
    const skipButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('跳过'),
    );
    await act(async () => {
      skipButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => expect(container.textContent).toContain('已跳过'));
    // Body is hidden in collapsed state
    expect(container.textContent).not.toContain('模型工具调用解析失败');

    // Click the collapsed bar to expand
    const expandButton = container.querySelector('button');
    await act(async () => {
      expandButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Now body should be visible again
    await vi.waitFor(() => expect(container.textContent).toContain('模型工具调用解析失败'));
    expect(container.textContent).toContain('已跳过');
  });

  it('hydrated resolved state starts collapsed', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      okJson({
        issue: {
          issueId: 'fi_test_status',
          status: 'confirmed',
          userDescription: 'Already submitted',
        },
      }),
    );

    await act(async () => {
      root.render(<FrustrationIssueCard block={issueBlock} />);
    });

    // Should be collapsed: shows badge but not body
    await vi.waitFor(() => expect(container.textContent).toContain('已记录'));
    expect(container.textContent).not.toContain('模型工具调用解析失败');
  });

  // ── Existing race condition tests ─────────────────────────

  it('keeps confirmed hydration when a duplicate confirm conflict resolves later', async () => {
    let resolveStatus!: (response: Response) => void;
    let resolveConfirm!: (response: Response) => void;
    const statusPromise = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });
    const confirmPromise = new Promise<Response>((resolve) => {
      resolveConfirm = resolve;
    });

    vi.mocked(apiFetch).mockImplementation((url, init) => {
      const path = String(url);
      if (path.endsWith('/status')) {
        return statusPromise;
      }
      if (path.endsWith('/confirm') && init?.method === 'POST') {
        return confirmPromise;
      }
      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    await act(async () => {
      root.render(<FrustrationIssueCard block={issueBlock} />);
    });

    const confirmButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('确认记录'),
    );
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      resolveStatus(okJson({ issue: { status: 'confirmed', userDescription: 'Already submitted' } }));
      await statusPromise;
    });

    await vi.waitFor(() => expect(container.textContent).toContain('已记录'));
    expect(container.textContent).not.toContain('确认记录');

    await act(async () => {
      resolveConfirm(errorJson(409, { error: 'Issue already confirmed' }));
      await confirmPromise;
    });

    expect(container.textContent).toContain('已记录');
    expect(container.textContent).not.toContain('确认记录');
    expect(container.textContent).not.toContain('Issue already confirmed');
  });
});
