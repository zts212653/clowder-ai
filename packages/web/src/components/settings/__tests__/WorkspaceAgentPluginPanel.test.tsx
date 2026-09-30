import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { WorkspaceAgentPluginPanel } from '../WorkspaceAgentPluginPanel';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe('WorkspaceAgentPluginPanel', () => {
  it('renders the disabled state without any token material', async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({ enabled: false, triggerId: null, workspaceId: null, tokenConfigured: false, source: null }),
    );
    await act(async () => {
      root!.render(<WorkspaceAgentPluginPanel />);
    });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/workspace-agent');
    expect(container!.textContent).toContain('Workspace Agent');
    expect(container!.textContent).toContain('未启用');
    // Token is never displayed because the API never returns one.
    expect(container!.querySelector('[data-testid="workspace-agent-token"]')!.getAttribute('value')).toBe('');
  });

  it('renders the invalid-config recovery guidance (restart or full save, not permission-only)', async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        enabled: false,
        triggerId: null,
        workspaceId: null,
        tokenConfigured: false,
        source: null,
        invalidConfig: { reason: 'unreadable_file' },
      }),
    );
    await act(async () => {
      root!.render(<WorkspaceAgentPluginPanel />);
    });
    const notice = container!.querySelector('[data-testid="workspace-agent-invalid"]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain('无法读取');
    expect(notice!.textContent).toContain('不会让当前实例自动重读');
  });

  it('saves config via PUT and never echoes the token back into the field', async () => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    mockApiFetch.mockImplementation(async (url: unknown) => {
      if (String(url).endsWith('/config')) {
        return jsonResponse({
          enabled: true,
          triggerId: 'agtch_live',
          workspaceId: 'ws_ui',
          tokenConfigured: true,
          source: 'settings',
        });
      }
      return jsonResponse({
        enabled: true,
        triggerId: 'agtch_ui',
        workspaceId: 'ws_ui',
        tokenConfigured: true,
        source: 'settings',
      });
    });
    await act(async () => {
      root!.render(<WorkspaceAgentPluginPanel />);
    });
    const triggerInput = container!.querySelector('[data-testid="workspace-agent-trigger-id"]') as HTMLInputElement;
    const tokenInput = container!.querySelector('[data-testid="workspace-agent-token"]') as HTMLInputElement;
    await act(async () => {
      nativeSetter.call(triggerInput, 'agtch_live');
      triggerInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      nativeSetter.call(tokenInput, 'secret-token-value');
      tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveButton = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent!.includes('保存并启用'),
    )!;
    await act(async () => {
      saveButton.dispatchEvent(new Event('click', { bubbles: true }));
    });
    const saveCall = mockApiFetch.mock.calls.find(([url]) => String(url).endsWith('/config'));
    expect(saveCall).toBeDefined();
    const body = JSON.parse(String(saveCall![1]!.body)) as Record<string, unknown>;
    expect(body.triggerId).toBe('agtch_live');
    expect(body.token).toBe('secret-token-value');
    expect((container!.querySelector('[data-testid="workspace-agent-token"]') as HTMLInputElement).value).toBe('');
  });

  it('surfaces a typed test failure without leaking anything', async () => {
    mockApiFetch.mockImplementation(async (url: unknown) => {
      if (String(url).endsWith('/test')) {
        return jsonResponse({ ok: false, code: 'WORKSPACE_AGENT_UNAUTHORIZED', message: 'token rejected (401)' }, 502);
      }
      return jsonResponse({
        enabled: true,
        triggerId: 'agtch_x',
        workspaceId: 'ws_x',
        tokenConfigured: true,
        source: 'settings',
      });
    });
    await act(async () => {
      root!.render(<WorkspaceAgentPluginPanel />);
    });
    const testButton = [...container!.querySelectorAll('button')].find((button) =>
      button.textContent!.includes('发送测试触发'),
    )!;
    await act(async () => {
      testButton.dispatchEvent(new Event('click', { bubbles: true }));
    });
    const result = container!.querySelector('[data-testid="workspace-agent-test-result"]')!;
    expect(result.textContent).toContain('WORKSPACE_AGENT_UNAUTHORIZED');
    expect(result.textContent).toContain('失败');
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('round-5 R3: provider-aware recovery actions in CloudConversationLink', () => {
  it('workspace-agent bound entries show the WA settings entry, never the Personal Chrome rebinding', async () => {
    const { CloudConversationLink } = await import('../../CloudConversationLink');
    mockApiFetch.mockImplementation(async () =>
      jsonResponse({
        bindings: {
          'gpt-pro': {
            provider: 'workspace-agent',
            conversationUrl: 'https://chatgpt.com/c/wa-recovery-1',
          },
        },
      }),
    );
    await act(async () => {
      root!.render(<CloudConversationLink threadId="thread-wa" />);
    });
    const container2 = document.querySelector('[data-testid="cloud-conversation-link"]')!;
    expect(container2.textContent).toContain('wa-recovery-1');
    expect(container2.querySelector('a[href="https://chatgpt.com/c/wa-recovery-1"]')).not.toBeNull();
    expect(container2.textContent).not.toContain('更换绑定');
    const waSettings = [...container2.querySelectorAll('a')].find((a) =>
      a.getAttribute('href')?.includes('#workspace-agent'),
    );
    expect(waSettings).toBeDefined();
  });
});

describe('round-6 N1: initial deep link locates the card after deferred load', () => {
  it('reveal runs once the state-driven card mounts, not before', async () => {
    const scrollCalls: number[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoViewSpy() {
      scrollCalls.push(1);
    };
    window.location.hash = '#workspace-agent';
    try {
      let releaseStatus: ((value: Response) => void) | undefined;
      const statusResponse = new Promise<Response>((resolve) => {
        releaseStatus = resolve;
      });
      mockApiFetch.mockImplementation(async () => statusResponse);
      await act(async () => {
        root!.render(<WorkspaceAgentPluginPanel />);
      });
      expect(scrollCalls.length).toBe(0); // card not mounted yet — no false reveal
      await act(async () => {
        releaseStatus!(
          jsonResponse({ enabled: false, triggerId: null, workspaceId: null, tokenConfigured: false, source: null }),
        );
      });
      expect(container!.querySelector('#workspace-agent')).not.toBeNull();
      expect(scrollCalls.length).toBeGreaterThan(0); // mounted → reveal fired
    } finally {
      Element.prototype.scrollIntoView = original;
      window.location.hash = '';
    }
  });
});
