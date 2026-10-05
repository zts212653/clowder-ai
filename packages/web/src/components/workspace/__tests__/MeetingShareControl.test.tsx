import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

describe('MeetingShareControl', () => {
  let root: Root;
  let container: HTMLDivElement;
  let sharing: boolean;
  const intent = {
    callId: 'call-1',
    generation: 1,
    captureThreadId: 'meeting-thread',
    meetingId: 'mtg-1',
    captureStartedAt: 100,
    inputId: 'app-1',
    inputLabel: 'Local test app',
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    sharing = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path !== '/api/concierge/meeting-share') throw new Error('unexpected path');
      if (options?.method === 'POST') {
        sharing = true;
        return { ok: true, json: async () => ({ sharing: true }) };
      }
      if (options?.method === 'DELETE') {
        sharing = false;
        return { ok: true, json: async () => ({ sharing: false }) };
      }
      return {
        ok: true,
        json: async () => ({ kind: 'available', intent, catId: 'codex6-sol', inputLabel: 'Local test app', sharing }),
      };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows exact current app and private-call scope; click shares once and can revoke', async () => {
    const { MeetingShareControl } = await import('../MeetingShareControl');
    await act(async () => {
      root.render(<MeetingShareControl />);
    });
    expect(container.textContent).toContain('Local test app');
    expect(container.textContent).toContain('existing and new transcript');
    expect(mockApiFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    const button = [...container.querySelectorAll('button')].find((element) => element.textContent?.includes('Share'));
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    const post = mockApiFetch.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(JSON.parse(post?.[1]?.body as string)).toEqual(intent);
    expect(container.textContent).toContain('Sharing with this private call');
    const revoke = [...container.querySelectorAll('button')].find((element) =>
      element.textContent?.includes('Stop sharing'),
    );
    expect(revoke).toBeTruthy();
    await act(async () => {
      revoke?.click();
    });
    expect(mockApiFetch.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(true);
    expect(container.textContent).toContain('Share transcript');
  });

  it('hides the action when no exact current capture and call can be verified', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ kind: 'unavailable' }) });
    const { MeetingShareControl } = await import('../MeetingShareControl');
    await act(async () => {
      root.render(<MeetingShareControl />);
    });
    expect(container.querySelector('button')).toBeNull();
    expect(mockApiFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  for (const [initialSharing, mutationMethod, expectedAction] of [
    [false, 'POST', 'Stop sharing'],
    [true, 'DELETE', 'Share transcript'],
  ] as const) {
    it(`uses a trailing GET after ${mutationMethod} when an older poll is pending`, async () => {
      sharing = initialSharing;
      let poll: (() => void) | undefined;
      vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
        poll = callback as () => void;
        return 1 as unknown as ReturnType<typeof setInterval>;
      });
      vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
      const preview = (value: boolean) => ({
        ok: true,
        json: async () => ({
          kind: 'available',
          intent,
          catId: 'codex6-sol',
          inputLabel: 'Local test app',
          sharing: value,
        }),
      });
      let releasePoll: ((response: ReturnType<typeof preview>) => void) | undefined;
      const pendingPoll = new Promise<ReturnType<typeof preview>>((resolve) => {
        releasePoll = resolve;
      });
      let getCount = 0;
      mockApiFetch.mockImplementation(
        (_path: string, options?: RequestInit, getOptions?: { afterCurrentGet?: boolean }) => {
          if (options?.method === mutationMethod) {
            sharing = mutationMethod === 'POST';
            return Promise.resolve({ ok: true });
          }
          getCount++;
          if (getCount === 1) return Promise.resolve(preview(initialSharing));
          return getOptions?.afterCurrentGet ? pendingPoll.then(() => preview(sharing)) : pendingPoll;
        },
      );

      const { MeetingShareControl } = await import('../MeetingShareControl');
      await act(async () => {
        root.render(<MeetingShareControl />);
      });
      expect(poll).toBeDefined();
      act(() => poll?.());
      const button = [...container.querySelectorAll('button')].find((node) =>
        node.textContent?.includes(initialSharing ? 'Stop sharing' : 'Share transcript'),
      );
      expect(button).toBeTruthy();
      act(() => button?.click());
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(getCount).toBe(3);
      await act(async () => {
        releasePoll?.(preview(initialSharing));
        await pendingPoll;
      });
      expect(container.textContent).toContain(expectedAction);
    });
  }
});
