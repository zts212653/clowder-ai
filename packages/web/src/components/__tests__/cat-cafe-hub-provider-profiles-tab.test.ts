import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

const storeState = {
  hubState: { open: true, tab: 'provider-profiles' },
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
        provider: 'anthropic',
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
import { HubProviderProfilesTab } from '@/components/HubProviderProfilesTab';

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
    vi.clearAllMocks();
  });

  it('renders provider profiles tab label', () => {
    const html = renderToStaticMarkup(React.createElement(CatCafeHub));
    expect(html).toContain('账号配置');
  });

  it('renders provider profiles tab initial loading state', () => {
    const html = renderToStaticMarkup(React.createElement(HubProviderProfilesTab));
    expect(html).toContain('加载中');
  });

  it('loads provider profiles for the current thread project when no explicit switcher selection exists', async () => {
    storeState.currentProjectPath = '/tmp/f127-worktree';
    let requestedPath = '';
    mockApiFetch.mockImplementation((path: string) => {
      requestedPath = path;
      return Promise.resolve(
        jsonResponse({
          projectPath: '/tmp/f127-worktree',
          activeProfileId: null,
          bootstrapBindings: {},
          providers: [],
        }),
      );
    });

    await act(async () => {
      root.render(React.createElement(HubProviderProfilesTab));
    });
    await flushEffects();

    expect(requestedPath).toBe(`/api/provider-profiles?projectPath=${encodeURIComponent('/tmp/f127-worktree')}`);
  });

  it('keeps ragdoll rescue controls out of provider profiles after tab data loads', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/provider-profiles')) {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-oauth',
            bootstrapBindings: {
              anthropic: { enabled: true, mode: 'oauth', accountRef: 'claude-oauth' },
            },
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
      root.render(React.createElement(HubProviderProfilesTab));
    });
    await flushEffects();

    expect(container.textContent).toContain('账号配置');
    expect(container.textContent).toContain('Claude (OAuth)');
    expect(container.textContent).toContain('Codex (OAuth)');
    expect(container.textContent).toContain('Gemini (OAuth)');
    expect(container.textContent).toContain('Codex Sponsor');
    expect(container.textContent).not.toContain('【');
    expect(container.textContent).not.toContain('非 UI 直出');
    expect(container.textContent).toContain('OpenCode (client-auth)');
    expect(container.textContent).toContain('Dare (client-auth)');
    expect(container.textContent).not.toContain('OAuth-like');
    expect(container.textContent).not.toContain('内置认证');
    expect(container.textContent).toContain('新建 API Key 账号');
    expect(container.textContent).not.toContain('布偶猫救援中心');
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/claude-rescue/sessions');
  });

  it('does not surface verify or activation controls on provider cards', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/provider-profiles')) {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-oauth',
            bootstrapBindings: {
              anthropic: { enabled: true, mode: 'oauth', accountRef: 'claude-oauth' },
              openai: { enabled: true, mode: 'api_key', accountRef: 'codex-sponsor' },
            },
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
      root.render(React.createElement(HubProviderProfilesTab));
    });
    await flushEffects();

    expect(container.textContent).not.toContain('验证');
    expect(container.textContent).not.toContain('当前默认：');
    expect(container.textContent).not.toContain('默认中');
    expect(container.textContent).not.toContain('测试');
  });

  it('renders provider cards without binding-scope action buttons', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/provider-profiles')) {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-oauth',
            bootstrapBindings: {
              anthropic: { enabled: true, mode: 'oauth', accountRef: 'claude-oauth' },
              openai: { enabled: true, mode: 'oauth', accountRef: 'codex-oauth' },
            },
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
                client: 'anthropic',
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
                client: 'openai',
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
      root.render(React.createElement(HubProviderProfilesTab));
    });
    await flushEffects();

    expect(container.textContent).not.toContain('设为 Codex 默认');
    expect(container.textContent).not.toContain('绑定范围');
  });

  it('renders API key creation form inline without protocol or verify controls', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/provider-profiles')) {
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
      root.render(React.createElement(HubProviderProfilesTab));
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
    const createApiKeyInput = container.querySelector('input[placeholder*="sk-"]') as HTMLInputElement | null;
    expect(createApiKeyInput).toBeTruthy();
    expect(createApiKeyInput?.type).toBe('password');
    expect(createApiKeyInput?.getAttribute('autocomplete')).toBe('off');
    expect(container.textContent).toContain('+ 添加模型');

    const profileList = container.querySelector('[aria-label="Provider Profile List"]');
    expect(profileList?.textContent).not.toContain('Antigravity');
    expect(container.textContent).toContain('可用模型');
    expect(container.textContent).not.toContain('测试');
  });

  it('creates api-key profile from name, url, api key, and supported models only', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            provider: {
              id: 'vendor-profile',
              displayName: 'Vendor Profile',
            },
          }),
        );
      }
      if (path.startsWith('/api/provider-profiles')) {
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
      root.render(React.createElement(HubProviderProfilesTab));
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

  it('pins create requests to the resolved projectPath even before the user touches the project switcher', async () => {
    storeState.currentProjectPath = 'default';
    let createPayload: Record<string, unknown> | null = null;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles' && init?.method === 'POST') {
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
      if (path.startsWith('/api/provider-profiles')) {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project-from-get',
            activeProfileId: null,
            bootstrapBindings: {},
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
      root.render(React.createElement(HubProviderProfilesTab));
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

    expect(createPayload).not.toBeNull();
    expect((createPayload as unknown as Record<string, unknown>)?.projectPath).toBe('/tmp/project-from-get');
  });

  it('shows built-in and custom provider cards together without the old filter tabs', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/provider-profiles')) {
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
      root.render(React.createElement(HubProviderProfilesTab));
    });
    await flushEffects();

    const profileList = container.querySelector('[aria-label="Provider Profile List"]');
    expect(profileList?.textContent).toContain('Claude (OAuth)');
    expect(profileList?.textContent).toContain('Codex (OAuth)');
    expect(profileList?.textContent).toContain('Gemini (OAuth)');
    expect(profileList?.textContent).toContain('Codex Sponsor');
    expect(profileList?.textContent).toContain('OpenCode (client-auth)');
    expect(profileList?.textContent).toContain('Dare (client-auth)');
    expect(container.textContent).not.toContain('全部');
    expect(container.textContent).not.toContain('内置认证');
    expect(
      Array.from(container.querySelectorAll('button')).filter((button) => button.textContent?.includes('编辑')),
    ).toHaveLength(1);
  });

  it('does not expose 测试 buttons on provider cards', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/provider-profiles')) {
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
      root.render(React.createElement(HubProviderProfilesTab));
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
