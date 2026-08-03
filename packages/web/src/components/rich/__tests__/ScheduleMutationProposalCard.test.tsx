import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { RichBlocks } from '../RichBlocks';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

Object.assign(globalThis as Record<string, unknown>, { React });

const scheduleBlock: RichCardBlock = {
  id: 'schedule-mutation-schedule-1',
  kind: 'card',
  v: 1,
  title: '提议创建定时任务：Stretch',
  bodyMarkdown: '批准后才会创建并注册该任务；当前尚未产生调度副作用。',
  tone: 'info',
  fields: [
    { label: 'Task ID', value: 'dyn-stretch' },
    { label: 'Trigger', value: '{"type":"once"}' },
  ],
  actions: [
    { label: '批准并创建', action: 'schedule:approve', payload: { proposalId: 'schedule-1' } },
    { label: '驳回', action: 'schedule:reject', payload: { proposalId: 'schedule-1' } },
  ],
};

const approvalMessageId = 'trusted-card-message';

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function scheduleSnapshot(status: 'pending' | 'applying' | 'approved' | 'rejected', messageId = approvalMessageId) {
  return {
    proposalId: 'schedule-1',
    status,
    publication: {
      state: 'anchored',
      envelope: {
        approvalCardRef: { threadId: 'thread-owner', messageId },
      },
    },
  };
}

describe('ScheduleMutationProposalCard', () => {
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

  it('routes the approval button to the F139 decision endpoint', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(
        okJson({
          proposal: scheduleSnapshot('pending'),
        }),
      )
      .mockResolvedValueOnce(okJson({ proposalId: 'schedule-1', status: 'approved' }));
    await act(async () => {
      root.render(<RichBlocks blocks={[scheduleBlock]} messageId={approvalMessageId} />);
      await Promise.resolve();
    });

    const approve = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('批准并创建'),
    );
    expect(approve).toBeDefined();

    await act(async () => {
      approve?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/schedule-proposals/schedule-1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('已批准');
  });

  it('routes the reject button to the F139 decision endpoint', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(
        okJson({
          proposal: scheduleSnapshot('pending'),
        }),
      )
      .mockResolvedValueOnce(okJson({ proposalId: 'schedule-1', status: 'rejected' }));
    await act(async () => {
      root.render(<RichBlocks blocks={[scheduleBlock]} messageId={approvalMessageId} />);
      await Promise.resolve();
    });

    const reject = [...container.querySelectorAll('button')].find((button) => button.textContent === '驳回');
    expect(reject).toBeDefined();

    await act(async () => {
      reject?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/schedule-proposals/schedule-1/reject',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('已驳回');
  });

  it('converges when another approval surface settles the proposal', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      okJson({
        proposal: scheduleSnapshot('pending'),
      }),
    );
    await act(async () => {
      root.render(<RichBlocks blocks={[scheduleBlock]} messageId={approvalMessageId} />);
      await Promise.resolve();
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:proposal-updated', {
          detail: scheduleSnapshot('approved'),
        }),
      );
    });

    expect(container.textContent).toContain('已批准');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('hydrates a settled proposal before showing decision actions after reload', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      okJson({
        proposal: scheduleSnapshot('approved'),
      }),
    );

    await act(async () => {
      root.render(<RichBlocks blocks={[scheduleBlock]} messageId={approvalMessageId} />);
      await Promise.resolve();
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/schedule-proposals/schedule-1');
    expect(container.textContent).toContain('已批准');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('fails closed when the rendered message is not the server-anchored approval card', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      okJson({
        proposal: {
          ...scheduleSnapshot('pending'),
        },
      }),
    );

    await act(async () => {
      root.render(<RichBlocks blocks={[scheduleBlock]} messageId="spoofed-card-message" />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('审批卡来源验证失败');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('offers approval retry when hydration finds a recoverable applying proposal', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(
        okJson({
          proposal: scheduleSnapshot('applying'),
        }),
      )
      .mockResolvedValueOnce(okJson({ proposalId: 'schedule-1', status: 'approved' }));

    await act(async () => {
      root.render(<RichBlocks blocks={[scheduleBlock]} messageId={approvalMessageId} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('正在执行');
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === '重试执行');
    expect(retry).toBeDefined();
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '驳回')).toBe(false);

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/schedule-proposals/schedule-1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('已批准');
  });

  it('fails closed when the durable proposal status cannot be hydrated', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'unavailable' }),
    } as Response);

    await act(async () => {
      root.render(<RichBlocks blocks={[scheduleBlock]} messageId={approvalMessageId} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('提案状态同步失败');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('keeps a newer socket settlement when the hydration response arrives later', async () => {
    let resolveHydration!: (response: Response) => void;
    vi.mocked(apiFetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveHydration = resolve;
      }),
    );

    act(() => root.render(<RichBlocks blocks={[scheduleBlock]} messageId={approvalMessageId} />));
    act(() => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:proposal-updated', {
          detail: scheduleSnapshot('approved'),
        }),
      );
    });
    await act(async () => {
      resolveHydration(
        okJson({
          proposal: scheduleSnapshot('pending'),
        }),
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('已批准');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
