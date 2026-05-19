import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/utils/api-client';
import type { Thread } from '../chat-types';
import { useChatStore } from '../chatStore';
import { useLabelStore } from '../label-store';

const mockApiFetch = vi.mocked(apiFetch);

function makeThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    projectPath: 'default',
    title: null,
    createdBy: 'user',
    participants: [],
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('label-store deleteLabel → chatStore thread sync', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({ ok: true } as Response);

    useLabelStore.setState({
      labels: [
        { id: 'l1', name: 'feat', color: '#3B82F6', sortOrder: 0, createdBy: 'u1', createdAt: 1 },
        { id: 'l2', name: 'bug', color: '#EF4444', sortOrder: 1, createdBy: 'u1', createdAt: 2 },
      ],
    });

    useChatStore.setState({
      threads: [
        makeThread({ id: 't1', labels: ['l1', 'l2'] }),
        makeThread({ id: 't2', labels: ['l1'] }),
        makeThread({ id: 't3' }),
      ],
    });
  });

  it('strips deleted label ID from all chatStore threads', async () => {
    await useLabelStore.getState().deleteLabel('l1');

    const threads = useChatStore.getState().threads;
    expect(threads.find((t) => t.id === 't1')?.labels).toEqual(['l2']);
    expect(threads.find((t) => t.id === 't2')?.labels).toBeUndefined();
    expect(threads.find((t) => t.id === 't3')?.labels).toBeUndefined();
  });

  it('does not touch threads without the deleted label', async () => {
    const t3Before = useChatStore.getState().threads.find((t) => t.id === 't3');
    await useLabelStore.getState().deleteLabel('l1');
    const t3After = useChatStore.getState().threads.find((t) => t.id === 't3');
    expect(t3After).toBe(t3Before);
  });

  it('does not strip labels when API delete fails', async () => {
    mockApiFetch.mockResolvedValue({ ok: false } as Response);
    await useLabelStore.getState().deleteLabel('l1');

    const threads = useChatStore.getState().threads;
    expect(threads.find((t) => t.id === 't1')?.labels).toEqual(['l1', 'l2']);
    expect(threads.find((t) => t.id === 't2')?.labels).toEqual(['l1']);
  });
});
