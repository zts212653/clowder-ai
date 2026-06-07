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

    await vi.waitFor(() => expect(container.textContent).toContain('已提交'));
    expect(container.textContent).not.toContain('确认提交');
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/frustration-issues/fi_test_status/status');
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
      button.textContent?.includes('确认提交'),
    );
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => expect(container.textContent).toContain('已提交'));
    expect(container.textContent).not.toContain('确认提交');

    await act(async () => {
      resolveStatus(okJson({ issue: { status: 'draft', userDescription: 'stale draft' } }));
      await statusPromise;
    });

    expect(container.textContent).toContain('已提交');
    expect(container.textContent).not.toContain('确认提交');
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
      button.textContent?.includes('确认提交'),
    );
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await vi.waitFor(() => expect(container.textContent).toContain('Issue already confirmed'));
    expect(container.textContent).toContain('确认提交');

    await act(async () => {
      resolveStatus(okJson({ issue: { status: 'confirmed', userDescription: 'Already submitted' } }));
      await statusPromise;
    });

    await vi.waitFor(() => expect(container.textContent).toContain('已提交'));
    expect(container.textContent).not.toContain('确认提交');
    expect(container.textContent).not.toContain('Issue already confirmed');
  });

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
      button.textContent?.includes('确认提交'),
    );
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      resolveStatus(okJson({ issue: { status: 'confirmed', userDescription: 'Already submitted' } }));
      await statusPromise;
    });

    await vi.waitFor(() => expect(container.textContent).toContain('已提交'));
    expect(container.textContent).not.toContain('确认提交');

    await act(async () => {
      resolveConfirm(errorJson(409, { error: 'Issue already confirmed' }));
      await confirmPromise;
    });

    expect(container.textContent).toContain('已提交');
    expect(container.textContent).not.toContain('确认提交');
    expect(container.textContent).not.toContain('Issue already confirmed');
  });
});
