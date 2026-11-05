import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationViewPreferenceController } from '@/hooks/useConversationViewPreference';
import { renderChatContainer, resetChatContainerMocks } from '../../__tests__/chat-container-test-helpers';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '../../shell/shell-presentation';

// Load after the shared ChatContainer fixture has installed its API mock.
const { apiFetch } = await import('@/utils/api-client');

const observed = vi.hoisted(() => ({ controller: null as ConversationViewPreferenceController | null }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/execution-row/ExecutionRow', () => ({ ExecutionRow: () => null }));
vi.mock('@/hooks/useConversationViewPreference', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useConversationViewPreference')>();
  return {
    ...actual,
    useConversationViewPreference: (threadId: string, enabled?: boolean) => {
      observed.controller = actual.useConversationViewPreference(threadId, enabled);
      return observed.controller;
    },
  };
});

const preferenceCalls = () => vi.mocked(apiFetch).mock.calls.filter(([url]) => url.includes('/conversation-view'));

describe('first-run landing conversation preference activation', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.history.replaceState(null, '', '/');
    localStorage.setItem('cat-cafe:first-run-quest-skipped', '1');
    writeShellPresentation('v2');
    resetChatContainerMocks();
    observed.controller = null;
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(async (url, options) => {
      if (!url.includes('/conversation-view')) return Response.json({ threads: [] });
      if (options?.method === 'PUT') {
        const { view } = JSON.parse(String(options.body));
        return Response.json({ stored: view, effective: view, source: 'thread' });
      }
      return Response.json({ stored: null, effective: { mode: 'group' }, source: 'product' });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.removeItem('cat-cafe:first-run-quest-skipped');
    localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(threadId: string) {
    window.history.replaceState(null, '', threadId === 'default' ? '/' : `/thread/${threadId}`);
    await act(async () => root.render(renderChatContainer(threadId)));
  }

  it('keeps the zero-role landing local, loads and saves a real thread, then resets on return', async () => {
    await render('default');
    expect(preferenceCalls()).toHaveLength(0);
    expect(observed.controller).toMatchObject({ loading: false, error: null });

    await render('thread-a');
    expect(preferenceCalls()).toHaveLength(1);
    expect(preferenceCalls()[0][0]).toBe('/api/config/conversation-view?threadId=thread-a');
    await act(async () => {
      expect(await observed.controller?.save({ mode: 'cat', catId: 'codex' })).toBe(true);
    });
    expect(JSON.parse(String(preferenceCalls()[1][1]?.body))).toEqual({
      threadId: 'thread-a',
      view: { mode: 'cat', catId: 'codex' },
    });
    expect(observed.controller?.snapshot.effective).toEqual({ mode: 'cat', catId: 'codex' });

    await render('default');
    expect(observed.controller).toMatchObject({
      loading: false,
      error: null,
      snapshot: { stored: null, effective: { mode: 'group' }, source: 'product' },
    });
    await act(async () => {
      expect(await observed.controller?.save({ mode: 'group' })).toBe(false);
    });
    expect(preferenceCalls()).toHaveLength(2);
  });

  it('still exposes a real thread ownership or missing-thread rejection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      url.includes('/conversation-view')
        ? Response.json({ error: 'Thread not found' }, { status: 404 })
        : Response.json({ threads: [] }),
    );
    await render('thread-a');
    expect(preferenceCalls()).toHaveLength(1);
    expect(observed.controller?.error).toBe('load');
    expect(error).toHaveBeenCalledWith('Failed to load conversation view preference', expect.any(Error));
  });
});
