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
const json = (body: unknown) => ({ ok: true, json: vi.fn(async () => body) }) as unknown as Response;
const deferredBody = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const response = new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
  vi.spyOn(response, 'json'); // Real body consumption waits for the stream, independently of HTTP headers.
  const release = (body: unknown) => {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
    controller.close();
  };
  return { response, release };
};
const startB = {
  type: 'status',
  status: 'started',
  thread_id: 'thread-B',
  meeting_id: 'meeting-B',
  inputs: [],
  health: {},
};
const stopB = { type: 'status', status: 'stopped', transcript_path: '/repo/meeting-B.md', duration_s: 1 };
const fresh = { type: 'transcript', ts: 2, elapsed_s: 1, chunk_num: 1, asr_latency: 0.2, text: 'B fresh body' };
const staleLine = { ts: 1, elapsed_s: 1, chunk_num: 1, asr_latency: 0.2, text: 'A stale body' };

describe.each([
  ['panel', TranscriptPanel],
  ['floating', FloatingTranscriptContainer],
] as const)('R6 asynchronous write boundary (%s)', (surface, Component) => {
  let root: Root;
  let container: HTMLDivElement;
  let statusResponse: Response;
  let transcriptResponse: Response;
  let stopResponse: Response;
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
    statusResponse = json({ running: false, thread_id: 'thread-A', meeting_id: 'meeting-A' });
    transcriptResponse = json({ lines: [] });
    stopResponse = json({ summary: {} });
    api.mockReset();
    api.mockImplementation(async (path: string) => {
      if (path === '/api/audio/status') return statusResponse;
      if (path === '/api/audio/transcript') return transcriptResponse;
      if (path === '/api/audio/stop') return stopResponse;
      if (path === '/api/audio/sources') return json({ apps: [{ id: 'app-A', name: 'App A' }], mics: [] });
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
  const render = async () => {
    await act(async () => {
      root.render(<Component />);
    });
  };
  const emit = async (event: unknown) => {
    await act(async () => {
      events.onmessage?.({ data: JSON.stringify(event) });
    });
  };

  it('positive control: delayed JSON within the same round still resolves the pending owner', async () => {
    const body = deferredBody();
    statusResponse = body.response;
    await render();
    expect(body.response.json).toHaveBeenCalledOnce();
    await emit({ type: 'status', status: 'stopped', transcript_path: '/repo/meeting-A.md', duration_s: 1 });
    await act(async () => {
      body.release({ running: false, thread_id: 'thread-A' });
    });
    expect(readMeetingSessionSummary()).toMatchObject({ threadId: 'thread-A', transcriptPath: '/repo/meeting-A.md' });
  });

  it('status JSON that completes after started B cannot overwrite B owner', async () => {
    const body = deferredBody();
    statusResponse = body.response;
    await render();
    expect(body.response.json).toHaveBeenCalledOnce();
    await emit(startB);
    await act(async () => {
      body.release({ running: false, thread_id: 'thread-A', meeting_id: 'meeting-A' });
    });
    await emit(stopB);
    expect(readMeetingSessionSummary()).toMatchObject({ threadId: 'thread-B', transcriptPath: '/repo/meeting-B.md' });
  });

  it('transcript JSON that completes after started B cannot replace its new body', async () => {
    const body = deferredBody();
    transcriptResponse = body.response;
    await render();
    expect(body.response.json).toHaveBeenCalledOnce();
    await emit(startB);
    await emit(fresh);
    await act(async () => {
      body.release({ lines: [staleLine] });
    });
    expect({
      fresh: document.body.textContent?.includes('B fresh body'),
      stale: document.body.textContent?.includes('A stale body'),
    }).toEqual({ fresh: true, stale: false });
  });

  if (surface === 'panel')
    it('stop JSON that completes after started B cannot save A summary into B', async () => {
      statusResponse = json({ running: true, thread_id: 'thread-A', meeting_id: 'meeting-A', inputs: [] });
      const body = deferredBody();
      stopResponse = body.response;
      await render();
      const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Stop');
      expect(button).toBeDefined();
      await act(async () => {
        button?.click();
      });
      expect(body.response.json).toHaveBeenCalledOnce();
      await emit(startB);
      await act(async () => {
        body.release({ summary: { transcript_path: '/repo/meeting-A.md' } });
      });
      expect(readMeetingSessionSummary()).toBeNull();
      expect(document.body.textContent).not.toContain('/repo/meeting-A.md');
    });

  if (surface === 'panel')
    it('an A stop delayed by share revocation cannot send its POST into started B', async () => {
      statusResponse = json({ running: true, thread_id: 'thread-A', meeting_id: 'meeting-A', inputs: [] });
      let release!: (response: Response) => void;
      const revoke = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const normal = api.getMockImplementation();
      api.mockImplementation((path: string, init?: RequestInit) =>
        path === '/api/concierge/meeting-share' && init?.method === 'DELETE' ? revoke : normal?.(path, init),
      );
      await render();
      const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Stop');
      expect(button).toBeDefined();
      await act(async () => {
        button?.click();
      });
      expect(
        api.mock.calls.some(([path, init]) => path === '/api/concierge/meeting-share' && init?.method === 'DELETE'),
      ).toBe(true);
      // Another authorized entry can finish A and start B while this handler still waits for share revocation.
      await emit({ type: 'status', status: 'stopped', transcript_path: '/repo/meeting-A.md', duration_s: 1 });
      await emit(startB);
      await act(async () => {
        release(json({ kind: 'unavailable' }));
      });
      expect(
        api.mock.calls.filter(([path, init]) => path === '/api/audio/stop' && init?.method === 'POST'),
      ).toHaveLength(0);
    });

  if (surface === 'floating')
    it('input_status refresh requested before started B cannot mark new B as stopped', async () => {
      await render();
      let release!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => {
        release = resolve;
      });
      api.mockImplementationOnce(() => response);
      await emit({ type: 'input_status', input_id: 'app', state: 'stopped' });
      await emit(startB);
      await emit(fresh);
      expect(document.querySelector('[data-testid="start-capture"]')).toBeNull();
      await act(async () => {
        release(json({ running: false, thread_id: 'thread-A' }));
      });
      expect(document.querySelector('[data-testid="start-capture"]')).toBeNull();
    });
});
