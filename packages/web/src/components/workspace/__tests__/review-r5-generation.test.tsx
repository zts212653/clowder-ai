import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { FloatingTranscriptContainer } from '../FloatingTranscriptContainer';
import { clearMeetingSessionSummary, readMeetingSessionSummary } from '../meeting-session-summary';
import { TranscriptPanel } from '../TranscriptPanel';

const api = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => api(...args), API_URL: 'http://test' }));
// JSDOM has no drag geometry; the actual floating view/controller remain in the probe.
vi.mock('react-rnd', () => ({ Rnd: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
let events: { onmessage: ((event: { data: string }) => void) | null };
vi.stubGlobal('EventSource', function FakeEventSource() {
  events = { onmessage: null };
  return {
    close() {},
    set onmessage(fn: (event: { data: string }) => void) {
      events.onmessage = fn;
    },
  };
});
const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
const sources = { apps: [{ id: 'app-A', name: 'App A' }], mics: [] };
const stopA = { type: 'status', status: 'stopped', transcript_path: '/repo/meeting-A.md', duration_s: 5 };
const startB = {
  type: 'status',
  status: 'started',
  thread_id: 'thread-B',
  meeting_id: 'meeting-B',
  inputs: [],
  health: {},
};

describe.each([
  ['panel', TranscriptPanel],
  ['floating', FloatingTranscriptContainer],
] as const)('R5 generation and pending-stop boundaries (%s)', (surface, Component) => {
  let root: Root;
  let container: HTMLDivElement;
  let releaseStatus: (response: Response) => void;
  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeShellPresentation('v2');
    writeShellLanguage('en');
    clearMeetingSessionSummary();
    useChatStore.setState({
      currentThreadId: 'thread-A',
      workspaceWorktreeId: 'wt-review',
      floatingTranscriptVisible: true,
    });
    const status = new Promise<Response>((resolve) => {
      releaseStatus = resolve;
    });
    api.mockReset();
    api.mockImplementation(async (path: string) => {
      if (path === '/api/audio/status') return status;
      if (path === '/api/audio/transcript') return json({ lines: [] });
      if (path === '/api/audio/sources') return json(sources);
      if (path === '/api/concierge/meeting-share') return json({ kind: 'unavailable' });
      if (path.startsWith('/api/workspace/worktrees')) return json({ worktrees: [] });
      return json({});
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const emit = async (event: unknown) => {
    await act(async () => {
      events.onmessage?.({ data: JSON.stringify(event) });
    });
  };
  const render = async () => {
    await act(async () => {
      root.render(<Component />);
    });
  };

  it('positive control: pending stop resolves normally without a reset or new capture', async () => {
    await render();
    await emit(stopA);
    expect(readMeetingSessionSummary()).toBeNull();
    await act(async () => {
      releaseStatus(json({ running: false, thread_id: 'thread-A' }));
    });
    expect(readMeetingSessionSummary()).toMatchObject({ threadId: 'thread-A', transcriptPath: '/repo/meeting-A.md' });
  });

  if (surface === 'panel')
    it('Start again cannot resurrect an explicitly discarded pending stopped result', async () => {
      await render();
      await emit(stopA);
      await act(async () => {
        (container.querySelector('[data-testid="start-again"]') as HTMLButtonElement).click();
      });
      expect(container.textContent).not.toContain('/repo/meeting-A.md');
      await act(async () => {
        releaseStatus(json({ running: false, thread_id: 'thread-A', avg_asr_latency: 0.3 }));
      });
      expect({
        cachedPath: readMeetingSessionSummary()?.transcriptPath ?? null,
        pathShown: container.textContent?.includes('/repo/meeting-A.md'),
        prepared: Boolean(container.querySelector('[data-testid="start-capture"]')),
      }).toEqual({ cachedPath: null, pathShown: false, prepared: true });
    });

  it('new started B cannot inherit an unresolved stop from the previous capture A', async () => {
    useChatStore.setState({ currentThreadId: 'thread-B' });
    await render();
    await emit(stopA);
    await emit(startB);
    await act(async () => {
      releaseStatus(json({ running: true, thread_id: 'thread-B', meeting_id: 'meeting-B', duration_s: 1 }));
    });
    expect(readMeetingSessionSummary()).toBeNull();
  });

  it('a status requested before started B cannot overwrite B with an old stopped A snapshot', async () => {
    useChatStore.setState({ currentThreadId: 'thread-B' });
    await render();
    await emit(startB);
    await act(async () => {
      releaseStatus(json({ running: false, thread_id: 'thread-A', meeting_id: 'meeting-A' }));
    });
    await emit({ type: 'status', status: 'stopped', transcript_path: '/repo/meeting-B.md', duration_s: 1 });
    expect(readMeetingSessionSummary()).toMatchObject({ threadId: 'thread-B', transcriptPath: '/repo/meeting-B.md' });
  });
});
