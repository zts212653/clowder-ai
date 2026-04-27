import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    isLoading: false,
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
    refresh: () => Promise.resolve([]),
  }),
}));

import { FirstRunQuestWizard } from '@/components/FirstRunQuestWizard';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function WizardHost({ onCreated }: { onCreated?: (tid: string) => void }) {
  const [open, setOpen] = useState(true);
  return <FirstRunQuestWizard open={open} onClose={() => setOpen(false)} onCreated={onCreated ?? (() => {})} />;
}

describe('FirstRunQuestWizard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders template step on open and loads templates', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      if (typeof url === 'string' && url.includes('/api/cat-templates')) {
        return jsonResponse({
          templates: [
            {
              id: 'opus',
              name: '布偶猫',
              nickname: '宪宪',
              avatar: '/avatars/opus.png',
              color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
              roleDescription: '主架构师',
              personality: '温柔但有主见',
            },
          ],
        });
      }
      return jsonResponse({});
    });

    await act(async () => {
      root.render(<WizardHost />);
    });
    await flushEffects();

    expect(container.textContent).toContain('选择角色模板');
    expect(container.textContent).toContain('布偶猫');
    expect(container.textContent).toContain('宪宪');
  });

  it('shows step title for template step', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ templates: [] }));

    await act(async () => {
      root.render(<WizardHost />);
    });
    await flushEffects();

    expect(container.textContent).toContain('第 1 步');
    expect(container.textContent).toContain('选择角色模板');
  });

  it('shows empty state when no templates available', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ templates: [] }));

    await act(async () => {
      root.render(<WizardHost />);
    });
    await flushEffects();

    expect(container.textContent).toContain('暂无可用角色模板');
  });

  it('handles template API errors gracefully', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'));

    await act(async () => {
      root.render(<WizardHost />);
    });
    await flushEffects();

    // Should degrade gracefully, not crash
    expect(container.textContent).toContain('暂无可用角色模板');
  });

  it('sends clientId (not client) in POST /api/cats payload', async () => {
    let catsPayload: Record<string, unknown> | null = null;

    mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/cat-templates')) {
        return jsonResponse({
          templates: [
            {
              id: 'ragdoll',
              name: '布偶猫',
              nickname: '宪宪',
              avatar: '/avatars/opus.png',
              color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
              roleDescription: '主架构师',
              personality: '温柔',
            },
          ],
        });
      }
      if (url.includes('/api/first-run/available-clients')) {
        return jsonResponse({
          clients: [
            {
              client: 'claude',
              provider: 'anthropic',
              label: 'Claude',
              cli: 'claude',
              installed: true,
              hasApiKey: false,
            },
          ],
        });
      }
      if (url.includes('/api/accounts')) {
        return jsonResponse({
          providers: [
            {
              id: 'claude',
              displayName: 'Claude (OAuth)',
              name: 'Claude (OAuth)',
              authType: 'oauth',

              mode: 'subscription',
              models: ['claude-opus-4-6'],
              hasApiKey: false,
              createdAt: '2026-01-01',
              updatedAt: '2026-01-01',
            },
          ],
        });
      }
      if (url.includes('/api/first-run/connectivity-test')) {
        return jsonResponse({ ok: true, message: '连接成功' });
      }
      if (url === '/api/cats' && init?.method === 'POST') {
        catsPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ cat: { id: 'ragdoll-test', displayName: '布偶猫' } });
      }
      if (url === '/api/threads' && init?.method === 'POST') {
        return jsonResponse({ id: 'thread-test-123' });
      }
      if (url === '/api/threads') {
        return jsonResponse({ threads: [] });
      }
      return jsonResponse({});
    });

    await act(async () => {
      root.render(<WizardHost />);
    });
    await flushEffects();

    // Step 1: select template
    const templateButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('布偶猫'),
    );
    expect(templateButton).toBeTruthy();
    await act(async () => {
      templateButton!.click();
    });
    await flushEffects();

    // Step 2: select client
    const clientButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Claude'));
    expect(clientButton).toBeTruthy();
    await act(async () => {
      clientButton!.click();
    });
    await flushEffects();

    // Step 3: profile auto-selected, select model, test, then create
    // Click test button
    const testButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('测试连接'));
    if (testButton) {
      await act(async () => {
        testButton.click();
      });
      await flushEffects();
    }

    // Click create button
    const createButton = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('创建猫猫'),
    );
    if (createButton && !createButton.disabled) {
      await act(async () => {
        createButton.click();
      });
      await flushEffects();
    }

    // Assert: POST /api/cats must use clientId, not client
    expect(catsPayload).not.toBeNull();
    expect(catsPayload!.clientId).toBe('anthropic');
    expect(catsPayload!.client).toBeUndefined();
  });
});
