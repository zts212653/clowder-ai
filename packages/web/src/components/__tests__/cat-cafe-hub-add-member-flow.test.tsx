import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

const storeState = {
  hubState: { open: true, tab: 'cats' },
  closeHub: () => {},
  threads: [],
  currentThreadId: 'thread-active',
  currentProjectPath: 'default',
  catInvocations: {},
  threadStates: {},
};

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
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

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

vi.mock('@/components/useConfirm', () => ({
  useConfirm: () => () => Promise.resolve(true),
}));

import { CatCafeHub } from '@/components/CatCafeHub';

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

async function click(button: HTMLElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function queryButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) {
    throw new Error(`Missing button: ${text}`);
  }
  return button as HTMLButtonElement;
}

describe('CatCafeHub add-member entry', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/config') {
        return Promise.resolve(
          jsonResponse({
            config: {
              coCreator: null,
              cats: {},
              a2a: { enabled: true, maxDepth: 3 },
              memory: { enabled: true, maxKeysPerThread: 20 },
              governance: {
                degradationEnabled: true,
                doneTimeoutMs: 30_000,
                heartbeatIntervalMs: 10_000,
              },
              ui: { bubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' } },
            },
          }),
        );
      }
      if (path === '/api/config/default-cat') {
        return Promise.resolve(
          jsonResponse({
            catId: '',
          }),
        );
      }
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-oauth',
            providers: [
              {
                id: 'claude-oauth',
                provider: 'claude-oauth',
                displayName: 'Claude (OAuth)',
                name: 'Claude (OAuth)',
                authType: 'oauth',
                protocol: 'anthropic',
                builtin: true,
                mode: 'subscription',
                models: ['claude-opus-4-6'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(
          jsonResponse({
            cats: [],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('opens the member editor directly from the cats.add-member CTA', async () => {
    await act(async () => {
      root.render(React.createElement(CatCafeHub));
    });
    await flushEffects();

    await click(queryButton(container, '添加成员'));
    await flushEffects();

    expect(container.querySelector('[data-guide-id="member-editor.auth-config"]')).not.toBeNull();
    expect(container.querySelector('[data-guide-id="add-member.client"]')).toBeNull();
  });
});
