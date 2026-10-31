import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';

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

/** F317 owner ruling (2026-10-04): v2 reads the shell dictionary; classic keeps the original English, byte-identical. */
describe('MeetingShareControl v2 language seam', () => {
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

  const mutationCalls = () =>
    mockApiFetch.mock.calls.filter(([, options]) => options?.method === 'POST' || options?.method === 'DELETE');

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    sharing = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    writeShellPresentation('v2');
    writeShellLanguage('zh');
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
    writeShellPresentation('classic');
    writeShellLanguage('zh');
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderControl() {
    const { MeetingShareControl } = await import('../MeetingShareControl');
    await act(async () => {
      root.render(<MeetingShareControl />);
    });
  }

  it('zh: button, description and aria are Chinese; the real inputLabel is never translated', async () => {
    await renderControl();
    expect(container.textContent).toContain('分享转写');
    expect(container.textContent).toContain('将本次采集会话已有和后续的转写分享给这次与猫的私人通话');
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('私人通话的转写分享');
    expect(container.textContent).toContain('Local test app');
    expect(mutationCalls()).toHaveLength(0);
  });

  it('en: button, description and aria follow the English preference; sharing state shows the active wording', async () => {
    sharing = true;
    writeShellLanguage('en');
    await renderControl();
    expect(container.textContent).toContain('Stop sharing');
    expect(container.textContent).toContain('Sharing with this private call. Stop sharing anytime.');
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Private call transcript sharing');
    expect(container.textContent).toContain('Local test app');
  });

  it('status unknown follows the current language', async () => {
    let poll: (() => void) | undefined;
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      poll = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    let getCount = 0;
    mockApiFetch.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path !== '/api/concierge/meeting-share') throw new Error('unexpected path');
      if (options?.method) return { ok: true, json: async () => ({}) };
      getCount += 1;
      if (getCount > 1) return { ok: false, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({ kind: 'available', intent, catId: 'codex6-sol', inputLabel: 'Local test app', sharing }),
      };
    });
    await renderControl();
    expect(poll).toBeDefined();
    await act(async () => {
      poll?.();
    });
    expect(container.textContent).toContain('无法确认分享状态。可停止分享或停止采集以撤销分享。');
  });

  it('failed POST shows the changed-call error, and switching language re-words it with no new POST/DELETE', async () => {
    mockApiFetch.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path !== '/api/concierge/meeting-share') throw new Error('unexpected path');
      if (options?.method === 'POST') return { ok: false, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({ kind: 'available', intent, catId: 'codex6-sol', inputLabel: 'Local test app', sharing }),
      };
    });
    await renderControl();
    const shareButton = [...container.querySelectorAll('button')].find((element) =>
      element.textContent?.includes('分享转写'),
    );
    await act(async () => {
      shareButton?.click();
    });
    expect(container.textContent).toContain('通话或采集已变化，请刷新后重试。');
    const mutationsBeforeSwitch = mutationCalls().length;
    await act(async () => {
      writeShellLanguage('en');
    });
    expect(container.textContent).toContain('The call or capture changed. Refresh and try again.');
    expect(container.textContent).not.toContain('通话或采集已变化');
    expect(mutationCalls().length).toBe(mutationsBeforeSwitch);
  });

  it('failed DELETE shows the stop-unconfirmed error in the current language', async () => {
    sharing = true;
    writeShellLanguage('en');
    mockApiFetch.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path !== '/api/concierge/meeting-share') throw new Error('unexpected path');
      if (options?.method === 'DELETE') return { ok: false, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({ kind: 'available', intent, catId: 'codex6-sol', inputLabel: 'Local test app', sharing }),
      };
    });
    await renderControl();
    const stopButton = [...container.querySelectorAll('button')].find((element) =>
      element.textContent?.includes('Stop sharing'),
    );
    await act(async () => {
      stopButton?.click();
    });
    expect(container.textContent).toContain('Could not confirm sharing stopped.');
  });

  it('a thrown mutation shows the private-status-unconfirmed error in the current language', async () => {
    mockApiFetch.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path !== '/api/concierge/meeting-share') throw new Error('unexpected path');
      if (options?.method === 'POST') throw new Error('network down');
      return {
        ok: true,
        json: async () => ({ kind: 'available', intent, catId: 'codex6-sol', inputLabel: 'Local test app', sharing }),
      };
    });
    await renderControl();
    const shareButton = [...container.querySelectorAll('button')].find((element) =>
      element.textContent?.includes('分享转写'),
    );
    await act(async () => {
      shareButton?.click();
    });
    expect(container.textContent).toContain('无法确认私人分享状态。');
  });

  it('classic keeps the original English even under the en preference, and a language flip adds no POST/DELETE', async () => {
    writeShellPresentation('classic');
    writeShellLanguage('en');
    await renderControl();
    expect(container.textContent).toContain('Share transcript');
    expect(container.textContent).toContain('existing and new transcript');
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Private call transcript sharing');
    await act(async () => {
      writeShellLanguage('zh');
    });
    expect(container.textContent).toContain('Share transcript');
    expect(mutationCalls()).toHaveLength(0);
  });
});
