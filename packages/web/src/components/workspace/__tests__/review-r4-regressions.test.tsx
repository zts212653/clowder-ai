import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { MeetingShareControl } from '../MeetingShareControl';
import { clearMeetingSessionSummary, readMeetingSessionSummary } from '../meeting-session-summary';
import { TranscriptPanel } from '../TranscriptPanel';

const api = vi.fn();
vi.mock('@/components/thread-chat/hub-socket-context', () => import('@/test-utils/hub-socket-context-mock'));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => api(...args), API_URL: 'http://test' }));
let events: { onmessage: ((event: { data: string }) => void) | null };
// NOTE: must stay a function expression (not arrow) — the panel calls `new EventSource(...)`.
vi.stubGlobal('EventSource', function FakeEventSource() {
  events = { onmessage: null };
  return {
    ...events,
    close() {},
    set onmessage(fn: (event: { data: string }) => void) {
      events.onmessage = fn;
    },
  };
});
const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
const sources = { apps: [{ id: 'app-A', name: 'App A' }], mics: [] };
const activeA = { running: true, thread_id: 'thread-A', source: 'app', duration_s: 5 };
const stoppedA = { type: 'status', status: 'stopped', transcript_path: '/repo/capture-A.md', duration_s: 5 };

describe('R4 independent lifecycle and source probes', () => {
  let root: Root;
  let container: HTMLDivElement;
  const defaultApi = async (path: string) => {
    if (path === '/api/audio/status') return json(activeA);
    if (path === '/api/audio/transcript')
      return json({ lines: [{ ts: 101, elapsed_s: 1, chunk_num: 1, asr_latency: 0.3, text: 'A capture content' }] });
    if (path === '/api/audio/sources') return json(sources);
    if (path.startsWith('/api/workspace/worktrees'))
      return json({
        worktrees: [{ id: 'wt-review', root: '/repo', resolvedRoot: '/repo', branch: 'main', head: 'abc' }],
      });
    if (path === '/api/concierge/meeting-share') return json({ kind: 'unavailable' });
    return json({});
  };
  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeShellPresentation('v2');
    writeShellLanguage('en');
    clearMeetingSessionSummary();
    useChatStore.setState({
      currentThreadId: 'thread-B',
      workspaceWorktreeId: 'wt-review',
      _workspaceFileSetAt: { ts: 0, threadId: null },
    });
    api.mockReset();
    api.mockImplementation(defaultApi);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('a stopped A capture viewed in B opens Files with actual source A', async () => {
    await act(async () => {
      root.render(<TranscriptPanel />);
    });
    await act(async () => {
      events.onmessage?.({ data: JSON.stringify(stoppedA) });
    });
    expect(readMeetingSessionSummary()?.threadId).toBe('thread-A');
    const open = container.querySelector('[data-testid="saved-path-open"]') as HTMLButtonElement;
    expect(open).not.toBeNull();
    await act(async () => {
      open.click();
    });
    expect(useChatStore.getState()._workspaceFileSetAt.navigationOrigin).toEqual({
      kind: 'meeting-transcript',
      threadId: 'thread-A',
    });
  });

  it('a stop arriving before initial producer status must not guess B as capture owner', async () => {
    let releaseStatus!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      releaseStatus = resolve;
    });
    api.mockImplementation((path: string) => (path === '/api/audio/status' ? pending : defaultApi(path)));
    await act(async () => {
      root.render(<TranscriptPanel />);
    });
    await act(async () => {
      events.onmessage?.({ data: JSON.stringify(stoppedA) });
    });
    await act(async () => {
      releaseStatus(json({ running: false, thread_id: 'thread-A' }));
    });
    expect(readMeetingSessionSummary()?.threadId).not.toBe('thread-B');
  });

  it('presentation switch preserves an in-flight sharing action and prevents a second POST', async () => {
    const release: Array<(response: Response) => void> = [];
    const intent = {
      callId: 'call-A',
      generation: 1,
      captureThreadId: 'thread-A',
      meetingId: 'mtg-A',
      captureStartedAt: 100,
      inputId: 'app-A',
      inputLabel: 'RAW A',
    };
    api.mockImplementation(async (_path: string, options?: RequestInit) => {
      if (options?.method === 'POST') return new Promise<Response>((resolve) => release.push(resolve));
      return json({ kind: 'available', intent, sharing: false, inputLabel: 'RAW A' });
    });
    await act(async () => {
      root.render(<MeetingShareControl />);
    });
    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
    });
    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    const callsBefore = api.mock.calls.length;
    await act(async () => {
      writeShellPresentation('classic');
    });
    const newButton = container.querySelector('button') as HTMLButtonElement;
    const stillBusy = newButton.disabled;
    const callsAfter = api.mock.calls.length;
    await act(async () => {
      newButton.click();
    });
    const posts = api.mock.calls.filter(([, options]) => options?.method === 'POST').length;
    await act(async () => {
      release.forEach((done) => {
        done(json({ sharing: true }));
      });
    });
    expect({ stillBusy, extraCallsOnSwitch: callsAfter - callsBefore, posts }).toEqual({
      stillBusy: true,
      extraCallsOnSwitch: 0,
      posts: 1,
    });
  });

  it('restores the complete stopped transcript and its exact file after leaving and returning', async () => {
    // Replaces two tests of a private browser probe's source with the actual retained-result consumer.
    useChatStore.setState({ currentThreadId: 'thread-A' });
    await act(async () => root.render(<TranscriptPanel />));
    const transcriptPath = '/repo/meeting.md';
    await act(async () =>
      events.onmessage?.({
        data: JSON.stringify({ ...stoppedA, transcript_path: transcriptPath }),
      }),
    );
    expect(readMeetingSessionSummary()?.transcriptPath).toBe(transcriptPath);
    expect(readMeetingSessionSummary()?.lines.map((line) => line.text)).toEqual(['A capture content']);
    await act(async () => root.render(null));
    api.mockImplementation((path: string) => {
      if (path === '/api/audio/status') return Promise.resolve(json({ running: false, thread_id: 'thread-A' }));
      if (path === '/api/audio/transcript') return Promise.resolve(json({ lines: [] }));
      return defaultApi(path);
    });
    await act(async () => root.render(<TranscriptPanel />));
    const path = container.querySelector('[data-testid="saved-paths-v2"] span[title]');
    expect(path?.getAttribute('title')).toBe(transcriptPath);
    expect(path?.textContent).toBe(transcriptPath);
    expect(container.textContent).toContain('A capture content');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="saved-path-open"]')?.click());
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('meeting.md');
    expect(useChatStore.getState()._workspaceFileSetAt.navigationOrigin).toEqual({
      kind: 'meeting-transcript',
      threadId: 'thread-A',
    });
  });
});
