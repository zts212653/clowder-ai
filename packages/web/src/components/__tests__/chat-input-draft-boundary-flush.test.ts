import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChatInput,
  threadContextAttachmentDrafts,
  threadDrafts,
  threadImageDrafts,
  threadReplyDrafts,
} from '@/components/ChatInput';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/components/icons/SendIcon', () => ({
  SendIcon: () => React.createElement('span', null, 'send'),
}));
vi.mock('@/components/icons/LoadingIcon', () => ({
  LoadingIcon: () => React.createElement('span', null, 'loading'),
}));
vi.mock('@/components/icons/AttachIcon', () => ({
  AttachIcon: () => React.createElement('span', null, 'attach'),
}));
vi.mock('@/utils/compressImage', () => ({ compressImage: (file: File) => Promise.resolve(file) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({
    name: 'ME',
    aliases: [],
    mentionPatterns: ['@co-creator'],
    color: { primary: '#D4A76A', secondary: '#FFF8F0' },
  }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], isLoading: false, getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));

function apiResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob(),
  } as Response;
}

function ownerDraft(threadId: string, revision: number, text: string) {
  return {
    version: 1 as const,
    ownerUserId: 'u1',
    threadId,
    revision,
    text,
    updatedAt: Date.now(),
  };
}

function ownerDraftResponse(threadId: string, revision: number, text: string | null): Response {
  const draft = text === null ? null : ownerDraft(threadId, revision, text);
  return apiResponse({ draft, revision });
}

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ChatInput durable draft boundary flush', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.useFakeTimers();
    threadDrafts.clear();
    threadImageDrafts.clear();
    threadReplyDrafts.clear();
    threadContextAttachmentDrafts.clear();
    useChatStore.setState({
      currentThreadId: 'default',
      hasDraft: false,
      threadStates: {},
      pendingChatInsert: null,
      replyToMessage: null,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function renderThread(threadId: string): Promise<void> {
    if (!root) root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(ChatInput, { threadId, onSend: vi.fn() }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function unmount(): void {
    act(() => root?.unmount());
    root = null;
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function typeInto(value: string): void {
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('flushes a hydrated clear on unmount with one versioned DELETE before remount hydration', async () => {
    let revision = 9;
    let text: string | null = 'stale body';
    const deletes: number[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url !== '/api/threads/thread-CLEAR/composer-draft') return apiResponse({});
      if (!init || init.method === 'GET') {
        return apiResponse({ draft: text === null ? null : ownerDraft('thread-CLEAR', revision, text), revision });
      }
      if (init.method === 'DELETE') {
        const request = JSON.parse(String(init.body)) as { expectedRevision: number };
        deletes.push(request.expectedRevision);
        text = null;
        revision += 1;
        return apiResponse({ cleared: true, revision });
      }
      return apiResponse({});
    });

    await renderThread('thread-CLEAR');
    act(() => typeInto(''));
    unmount();
    await settle();

    expect(deletes).toEqual([9]);
    await renderThread('thread-CLEAR');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('flushes the latest pending non-empty snapshot on unmount with a versioned PUT', async () => {
    const puts: Array<{ expectedRevision: number; text: string }> = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url !== '/api/threads/thread-PUT/composer-draft') return apiResponse({});
      if (!init || init.method === 'GET') return apiResponse({ draft: null, revision: 3 });
      const request = JSON.parse(String(init.body)) as { expectedRevision: number; text: string };
      puts.push(request);
      return apiResponse({ draft: ownerDraft('thread-PUT', request.expectedRevision + 1, request.text) });
    });

    await renderThread('thread-PUT');
    act(() => typeInto('latest local body'));
    unmount();
    await settle();

    expect(puts).toEqual([{ expectedRevision: 3, text: 'latest local body' }]);
  });

  it('serializes boundary DELETE before a rapid remount PUT and leaves the newest body authoritative', async () => {
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let revision = 5;
    let text: string | null = 'old body';
    const writes: Array<{ method: string; expectedRevision: number; text?: string }> = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url !== '/api/threads/thread-SERIAL/composer-draft') return apiResponse({});
      if (!init) return ownerDraftResponse('thread-SERIAL', revision, text);
      if (init.method === 'GET') return ownerDraftResponse('thread-SERIAL', revision, text);
      const request = JSON.parse(String(init.body)) as { expectedRevision: number; text?: string };
      writes.push({ method: String(init.method), ...request });
      if (init.method === 'DELETE') {
        await deleteGate;
        text = null;
        revision += 1;
        return apiResponse({ cleared: true, revision });
      }
      text = request.text ?? '';
      revision += 1;
      return apiResponse({ draft: ownerDraft('thread-SERIAL', revision, text) });
    });

    await renderThread('thread-SERIAL');
    act(() => typeInto(''));
    unmount();
    await settle();
    expect(writes).toEqual([{ method: 'DELETE', expectedRevision: 5 }]);

    root = createRoot(container);
    act(() => {
      root?.render(React.createElement(ChatInput, { threadId: 'thread-SERIAL', onSend: vi.fn() }));
    });
    act(() => typeInto('new body'));
    await settle();
    expect(writes).toHaveLength(1);
    releaseDelete();
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(401));

    expect(writes).toEqual([
      { method: 'DELETE', expectedRevision: 5 },
      { method: 'PUT', expectedRevision: 6, text: 'new body' },
    ]);
    expect(text).toBe('new body');
  });

  it('reconciles a boundary clear conflict to the authoritative draft', async () => {
    let reads = 0;
    const deletes: number[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url !== '/api/threads/thread-CONFLICT/composer-draft') return apiResponse({});
      if (!init || init.method === 'GET') {
        reads += 1;
        const revision = reads === 1 ? 5 : 6;
        const text = reads === 1 ? 'old body' : 'other tab body';
        return apiResponse({ draft: ownerDraft('thread-CONFLICT', revision, text), revision });
      }
      const request = JSON.parse(String(init.body)) as { expectedRevision: number };
      deletes.push(request.expectedRevision);
      return apiResponse({ code: 'DRAFT_REVISION_MISMATCH', actualRevision: 6 }, 409);
    });

    await renderThread('thread-CONFLICT');
    act(() => typeInto(''));
    unmount();
    await settle();
    await renderThread('thread-CONFLICT');

    expect(deletes).toEqual([5]);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('other tab body');
  });

  it('retains both authoritative and local text when a boundary PUT fails', async () => {
    const puts: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url !== '/api/threads/thread-FAIL/composer-draft') return apiResponse({});
      if (!init || init.method === 'GET') {
        return apiResponse({ draft: ownerDraft('thread-FAIL', 4, 'server body'), revision: 4 });
      }
      const request = JSON.parse(String(init.body)) as { text: string };
      puts.push(request.text);
      return apiResponse({ error: 'unavailable' }, 503);
    });

    await renderThread('thread-FAIL');
    act(() => typeInto('local edit'));
    unmount();
    await settle();
    await renderThread('thread-FAIL');

    expect(puts).toEqual(['local edit']);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('server body\n\nlocal edit');
  });

  it('does not write on unmount when the hydrated draft was not edited', async () => {
    const writes: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url !== '/api/threads/thread-NOOP/composer-draft') return apiResponse({});
      if (!init || init.method === 'GET') {
        return apiResponse({ draft: ownerDraft('thread-NOOP', 2, 'unchanged'), revision: 2 });
      }
      writes.push(String(init.method));
      return apiResponse({});
    });

    await renderThread('thread-NOOP');
    unmount();
    await settle();

    expect(writes).toEqual([]);
  });
});
