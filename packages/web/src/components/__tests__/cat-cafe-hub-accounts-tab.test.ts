import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';

const storeState = {
  hubState: { open: true, tab: 'accounts' },
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
    cats: [
      {
        id: 'opus',
        displayName: '布偶猫',
        nickname: '宪宪',
        color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
        mentionPatterns: ['@opus'],
        clientId: 'anthropic',
        defaultModel: 'claude-opus-4-6',
        avatar: '/avatars/opus.png',
        roleDescription: '架构',
        personality: '稳重',
      },
    ],
    isLoading: false,
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
    refresh: () => Promise.resolve([]),
  }),
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName,
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

import { CatCafeHub } from '@/components/CatCafeHub';
import { HubAccountsTab } from '@/components/HubAccountsTab';

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

async function changeField(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
  eventType: 'input' | 'change' = 'input',
) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event(eventType, { bubbles: true }));
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

const SETTINGS_GUIDE_FLOW = {
  id: 'add-account-auth',
  name: '添加账户认证',
  steps: [{ id: 'expand-settings', target: 'settings.group', tips: '展开系统配置分组', advance: 'click' as const }],
};

const CREATE_FORM_GUIDE_FLOW = {
  id: 'add-api-key-account',
  name: '新建 API Key 账号',
  steps: [
    {
      id: 'open-create-form',
      target: 'accounts.create-form',
      tips: '展开新建 API Key 账号表单',
      advance: 'click' as const,
    },
  ],
};

describe('CatCafeHub provider profiles tab', () => {
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    act(() => {
      useGuideStore.getState().exitGuide();
    });
    vi.clearAllMocks();
  });

  it('renders provider profiles tab label', () => {
    const html = renderToStaticMarkup(React.createElement(CatCafeHub));
    expect(html).toContain('账号配置');
  });

  it('renders provider profiles tab initial loading state', () => {
    const html = renderToStaticMarkup(React.createElement(HubAccountsTab));
    expect(html).toContain('加载中');
  });

  it('loads global provider profiles without projectPath (global profiles stored in ~/.cat-cafe/)', async () => {
    // Global profiles are stored in ~/.cat-cafe/ and shared across all projects
    // No projectPath is needed in the API call
    let requestedPath = '';
    mockApiFetch.mockImplementation((path: string) => {
      requestedPath = path;
      return Promise.resolve(
        jsonResponse({
          activeProfileId: null,
          providers: [],
        }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HubAccountsTab));
    });
    await flushEffects();

    // Global profiles: no projectPath in URL
    expect(requestedPath).toBe('/api/accounts');
  });

  it('keeps ragdoll rescue controls out of provider profiles after tab data loads', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/accounts')) {
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
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                builtin: true,
                mode: 'subscription',
                models: ['gpt-5.4'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'gemini-oauth',
                provider: 'gemini-oauth',
                displayName: 'Gemini (OAuth)',
                name: 'Gemini (OAuth)',
                authType: 'oauth',
                protocol: 'google',
                builtin: true,
                mode: 'subscription',
                models: ['gemini-2.5-pro'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                baseUrl: 'https://api.openai-proxy.dev',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubAccountsTab));
    });
    await flushEffects();

    expect(container.textContent).toContain('账号配置');
    expect(container.textContent).toContain('Claude (OAuth)');
    expect(container.textContent).toContain('Codex (OAuth)');
    expect(container.textContent).toContain('Gemini (OAuth)');
    expect(container.textContent).toContain('Codex Sponsor');
    expect(container.textContent).not.toContain('【');
    expect(container.textContent).not.toContain('非 UI 直出');
    expect(container.textContent).not.toContain('OpenCode (client-auth)');
    expect(container.textContent).not.toContain('Dare (client-auth)');
    expect(container.textContent).not.toContain('OAuth-like');
    expect(container.textContent).not.toContain('内置认证');
    expect(container.textContent).toContain('新建 API Key 账号');
    expect(container.textContent).not.toContain('布偶猫救援中心');
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/claude-rescue/sessions');
  });

  it('does not surface verify or activation controls on provider cards', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/accounts')) {
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
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                baseUrl: 'https://api.openai-proxy.dev',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubAccountsTab));
    });
    await flushEffects();

    expect(container.textContent).not.toContain('验证');
    expect(container.textContent).not.toContain('当前默认：');
    expect(container.textContent).not.toContain('默认中');
    expect(container.textContent).not.toContain('测试');
  });

  it('renders provider cards without binding-scope action buttons', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/accounts')) {
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
                clientId: 'anthropic',
                models: ['claude-opus-4-6'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                builtin: true,
                mode: 'subscription',
                clientId: 'openai',
                models: ['gpt-5.4'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                baseUrl: 'https://api.openai-proxy.dev',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubAccountsTab));
    });
    await flushEffects();

    expect(container.textContent).not.toContain('设为 Codex 默认');
    expect(container.textContent).not.toContain('绑定范围');
  });

  it('renders API key creation form without protocol selector (auto-inferred)', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/accounts')) {
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
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                builtin: true,
                mode: 'subscription',
                models: ['gpt-5.4'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'gemini-oauth',
                provider: 'gemini-oauth',
                displayName: 'Gemini (OAuth)',
                name: 'Gemini (OAuth)',
                authType: 'oauth',
                protocol: 'google',
                builtin: true,
                mode: 'subscription',
                models: ['gemini-2.5-pro'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                baseUrl: 'https://api.openai-proxy.dev',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubAccountsTab));
    });
    await flushEffects();

    expect(container.textContent).toContain('内置');
    expect(container.textContent).toContain('系统配置 > 账号配置');
    expect(container.textContent).toContain('+ 新建 API Key 账号');
    expect(container.textContent).not.toContain('默认/覆盖模型');

    // Form is collapsed by default — expand it
    const expandButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('新建 API Key 账号'),
    )!;
    await act(async () => {
      expandButton.click();
    });
    await flushEffects();

    expect(container.querySelector('input[placeholder*="API 服务地址"]')).toBeTruthy();
    // Protocol is auto-inferred, no manual selector
    expect(container.textContent).not.toContain('API 协议');
    const createApiKeyInput = container.querySelector('input[placeholder*="sk-"]') as HTMLInputElement | null;
    expect(createApiKeyInput).toBeTruthy();
    expect(createApiKeyInput?.type).toBe('password');
    expect(createApiKeyInput?.getAttribute('autocomplete')).toBe('off');
    expect(container.textContent).toContain('+ 添加模型');

    const profileList = container.querySelector('[aria-label="Account List"]');
    expect(profileList?.textContent).not.toContain('Antigravity');
    expect(container.textContent).toContain('可用模型');
    expect(container.textContent).not.toContain('测试');
  });

  it('anchors the create-form guide target on the expand button itself', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/accounts')) {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-oauth',
            providers: [],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubAccountsTab));
    });
    await flushEffects();

    const guideTarget = container.querySelector('[data-guide-id="accounts.create-form"]');
    const expandButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('新建 API Key 账号'),
    );

    expect(guideTarget).toBeTruthy();
    expect(expandButton).toBeTruthy();
    expect(guideTarget).toBe(expandButton);
    expect(guideTarget?.tagName).toBe('BUTTON');
  });

  it('exposes actionable guide targets for the expanded account details and submit button', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/accounts')) {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: null,
            providers: [],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubAccountsTab));
    });
    await flushEffects();

    const expandButton = container.querySelector('[data-guide-id="accounts.create-form"]') as HTMLButtonElement | null;
    expect(expandButton).toBeTruthy();

    await act(async () => {
      expandButton?.click();
    });
    await flushEffects();

    const detailsTarget = container.querySelector('[data-guide-id="accounts.create-details"]');
    const submitTarget = container.querySelector('[data-guide-id="accounts.create-submit"]');

    expect(detailsTarget).toBeTruthy();
    expect(detailsTarget?.querySelector('input[placeholder*="账号显示名"]')).toBeTruthy();
    expect(detailsTarget?.querySelector('input[placeholder*="API 服务地址"]')).toBeTruthy();
    expect(detailsTarget?.querySelector('input[placeholder*="sk-"]')).toBeTruthy();
    expect(submitTarget).toBeTruthy();
    expect(submitTarget?.tagName).toBe('BUTTON');
  });

  it('keeps settings expanded when the current guide step targets settings.group', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/config') {
        return Promise.resolve(
          jsonResponse({ config: { cats: {}, perCatBudgets: {}, a2a: {}, memory: {}, hindsight: {}, governance: {} } }),
        );
      }
      if (path.startsWith('/api/accounts')) {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: null,
            providers: [],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(CatCafeHub));
    });
    await flushEffects();

    const settingsToggle = container.querySelector('[data-guide-id="settings.group"]') as HTMLButtonElement | null;
    expect(settingsToggle).toBeTruthy();

    if (!container.querySelector('[data-guide-id="settings.accounts"]')) {
      await act(async () => {
        settingsToggle?.click();
      });
      await flushEffects();
    }

    expect(container.querySelector('[data-guide-id="settings.accounts"]')).toBeTruthy();

    await act(async () => {
      useGuideStore.getState().startGuide(SETTINGS_GUIDE_FLOW);
      useGuideStore.getState().setPhase('active');
    });

    await act(async () => {
      settingsToggle?.click();
    });
    await flushEffects();

    expect(container.querySelector('[data-guide-id="settings.accounts"]')).toBeTruthy();
  });

  it('keeps the create-form expanded when the current guide step targets accounts.create-form', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/accounts')) {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: null,
            providers: [],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubAccountsTab));
    });
    await flushEffects();

    const expandButton = container.querySelector('[data-guide-id="accounts.create-form"]') as HTMLButtonElement | null;
    expect(expandButton).toBeTruthy();

    await act(async () => {
      expandButton?.click();
    });
    await flushEffects();

    expect(container.querySelector('input[placeholder*="API 服务地址"]')).toBeTruthy();

    await act(async () => {
      useGuideStore.getState().startGuide(CREATE_FORM_GUIDE_FLOW);
      useGuideStore.getState().setPhase('active');
    });

    await act(async () => {
      expandButton?.click();
    });
    await flushEffects();

    expect(container.querySelector('input[placeholder*="API 服务地址"]')).toBeTruthy();
  });

  it('creates api-key profile from name, url, api key, and supported models only', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            provider: {
              id: 'vendor-profile',
              displayName: 'Vendor Profile',
            },
          }),
        );
      }
      if (path.startsWith('/api/accounts')) {
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
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubAccountsTab));
    });
    await flushEffects();

    // Expand the collapsed create form
    const expandButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('新建 API Key 账号'),
    )!;
    await act(async () => {
      expandButton.click();
    });
    await flushEffects();

    const displayNameInput = container.querySelector('input[placeholder*="账号显示名"]') as HTMLInputElement;
    const baseUrlInput = container.querySelector('input[placeholder*="API 服务地址"]') as HTMLInputElement;
    const apiKeyInput = container.querySelector('input[placeholder*="sk-"]') as HTMLInputElement;
    expect(apiKeyInput.type).toBe('password');
    expect(apiKeyInput.getAttribute('autocomplete')).toBe('off');
    const createButton = queryButton(container, '创建');

    await changeField(displayNameInput, 'Sponsor Gemini');
    await changeField(baseUrlInput, 'https://llm.sponsor.example/v1');
    await changeField(apiKeyInput, 'sk-test');
    await flushEffects();

    // Create button disabled until at least 1 model is added via TagEditor
    expect(createButton.disabled).toBe(true);

    // Verify the form uses a tag editor (not a textarea) for models
    expect(container.querySelector('textarea[aria-label="Supported Models"]')).toBeNull();
    expect(container.textContent).toContain('可用模型');
    expect(container.textContent).toContain('至少添加 1 个模型');
  });

  it('creates api-key profile without projectPath (global profiles stored in ~/.cat-cafe/)', async () => {
    // Global profiles: no projectPath in POST body
    let createPayload: Record<string, unknown> | null = null;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts' && init?.method === 'POST') {
        createPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve(
          jsonResponse({
            profile: {
              id: 'vendor-profile',
              displayName: 'Vendor Profile',
            },
          }),
        );
      }
      if (path.startsWith('/api/accounts')) {
        return Promise.resolve(
          jsonResponse({
            activeProfileId: null,
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
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubAccountsTab));
    });
    await flushEffects();

    // Expand the collapsed create form
    const expandButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('新建 API Key 账号'),
    )!;
    await act(async () => {
      expandButton.click();
    });
    await flushEffects();

    const displayNameInput = container.querySelector('input[placeholder*="账号显示名"]') as HTMLInputElement;
    const baseUrlInput = container.querySelector('input[placeholder*="API 服务地址"]') as HTMLInputElement;
    const apiKeyInput = container.querySelector('input[placeholder*="sk-"]') as HTMLInputElement;

    await changeField(displayNameInput, 'Sponsor Gemini');
    await changeField(baseUrlInput, 'https://llm.sponsor.example/v1');
    await changeField(apiKeyInput, 'sk-test');

    const addButtons = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.textContent?.trim() === '+ 添加模型',
    );
    const createFormAddButton = addButtons[addButtons.length - 1] as HTMLButtonElement;
    await act(async () => {
      createFormAddButton.click();
    });

    const tagDraftInput = container.querySelector('input[placeholder*="输入模型名"]') as HTMLInputElement;
    await changeField(tagDraftInput, 'gemini-2.5-pro');

    const confirmAddButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '添加',
    ) as HTMLButtonElement | undefined;
    expect(confirmAddButton).toBeTruthy();
    await act(async () => {
      confirmAddButton?.click();
    });

    const createButton = queryButton(container, '创建');
    expect(createButton.disabled).toBe(false);

    await act(async () => {
      createButton.click();
    });
    await flushEffects();

    // Global profiles: no projectPath in POST body
    expect(createPayload).not.toBeNull();
    expect((createPayload as unknown as Record<string, unknown>)?.projectPath).toBeUndefined();
  });

  it('shows only configured provider cards without synthesizing unconfigured builtins', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/accounts')) {
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
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                builtin: true,
                mode: 'subscription',
                models: ['gpt-5.4'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'gemini-oauth',
                provider: 'gemini-oauth',
                displayName: 'Gemini (OAuth)',
                name: 'Gemini (OAuth)',
                authType: 'oauth',
                protocol: 'google',
                builtin: true,
                mode: 'subscription',
                models: ['gemini-2.5-pro'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                baseUrl: 'https://api.openai-proxy.dev',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubAccountsTab));
    });
    await flushEffects();

    const profileList = container.querySelector('[aria-label="Account List"]');
    expect(profileList?.textContent).toContain('Claude (OAuth)');
    expect(profileList?.textContent).toContain('Codex (OAuth)');
    expect(profileList?.textContent).toContain('Gemini (OAuth)');
    expect(profileList?.textContent).toContain('Codex Sponsor');
    expect(profileList?.textContent).not.toContain('Kimi (OAuth)');
    expect(profileList?.textContent).not.toContain('OpenCode (client-auth)');
    expect(profileList?.textContent).not.toContain('Dare (client-auth)');
    expect(container.textContent).not.toContain('全部');
    expect(container.textContent).not.toContain('内置认证');
    expect(
      Array.from(container.querySelectorAll('button')).filter((button) => button.textContent?.includes('编辑')),
    ).toHaveLength(1);
  });

  it('does not expose 测试 buttons on provider cards', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/accounts')) {
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
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                baseUrl: 'https://api.openai-proxy.dev',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubAccountsTab));
    });
    await flushEffects();

    expect(
      Array.from(container.querySelectorAll('button')).filter((button) => button.textContent?.trim() === '测试'),
    ).toHaveLength(0);
    expect(container.textContent).toContain('Codex Sponsor');
  });

  it('renders ragdoll rescue section from the dedicated rescue tab', async () => {
    storeState.hubState = { open: true, tab: 'rescue' };
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/config') {
        return Promise.resolve(
          jsonResponse({ config: { cats: {}, perCatBudgets: {}, a2a: {}, memory: {}, hindsight: {}, governance: {} } }),
        );
      }
      if (path === '/api/claude-rescue/sessions') {
        return Promise.resolve(
          jsonResponse({
            sessions: [
              {
                sessionId: 'claude-session-1',
                transcriptPath: '/tmp/claude-session-1.jsonl',
                removableThinkingTurns: 2,
                detectedBy: 'api_error_entry',
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(CatCafeHub));
    });
    await flushEffects();

    expect(container.textContent).toContain('布偶猫救援中心');
    expect(container.textContent).toContain('检测到 1 只布偶猫 session 需要救援');
  });
});
