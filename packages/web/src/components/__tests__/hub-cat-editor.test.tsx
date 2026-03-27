import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

const mockConfirm = vi.fn(() => Promise.resolve(true));
vi.mock('@/components/useConfirm', () => ({
  useConfirm: () => mockConfirm,
}));

import { HubCatEditor } from '@/components/HubCatEditor';
import {
  buildCatPayload,
  DEFAULT_ANTIGRAVITY_COMMAND_ARGS,
  filterProfiles,
  type HubCatEditorFormState,
  splitCommandArgs,
  validateModelFormatForClient,
} from '@/components/hub-cat-editor.model';
import type { ProfileItem } from '@/components/hub-provider-profiles.types';

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
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  eventType: 'input' | 'change' = 'input',
) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event(eventType, { bubbles: true }));
  });
}

function queryField<T extends HTMLElement>(container: HTMLElement, selector: string): T {
  const element = container.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element as T;
}

describe('HubCatEditor', () => {
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
    mockConfirm.mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('buildCatPayload keeps name in PATCH payload when editing an existing cat', () => {
    const form: HubCatEditorFormState = {
      catId: 'runtime-codex',
      name: '运行时缅因猫',
      displayName: '运行时缅因猫',
      nickname: '',
      avatar: '/avatars/codex.png',
      colorPrimary: '#16a34a',
      colorSecondary: '#bbf7d0',
      mentionPatterns: '@runtime-codex',
      roleDescription: '审查',
      personality: '严谨',
      teamStrengths: '',
      caution: '',
      strengths: '',
      client: 'openai',
      accountRef: '',
      defaultModel: 'gpt-5.4',
      commandArgs: '',
      cliConfigArgs: [],
      ocProviderName: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
    };
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      provider: 'openai',
      defaultModel: 'gpt-5.4',
      color: { primary: '#16a34a', secondary: '#bbf7d0' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: '审查',
    } as CatData;

    const payload = buildCatPayload(form, existingCat) as Record<string, unknown>;
    expect(payload.name).toBe('运行时缅因猫');
  });

  it('buildCatPayload recomputes mcpSupport when client changes on existing cat', () => {
    const baseForm: HubCatEditorFormState = {
      catId: 'runtime-codex',
      name: '运行时缅因猫',
      displayName: '运行时缅因猫',
      nickname: '',
      avatar: '/avatars/codex.png',
      colorPrimary: '#16a34a',
      colorSecondary: '#bbf7d0',
      mentionPatterns: '@runtime-codex',
      roleDescription: '审查',
      personality: '严谨',
      teamStrengths: '',
      caution: '',
      strengths: '',
      client: 'openai',
      accountRef: '',
      defaultModel: 'gpt-5.4',
      commandArgs: '',
      cliConfigArgs: [],
      ocProviderName: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
    };
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      provider: 'antigravity',
      defaultModel: 'gemini-bridge',
      color: { primary: '#16a34a', secondary: '#bbf7d0' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: '审查',
    } as CatData;

    const payload = buildCatPayload(baseForm, existingCat) as Record<string, unknown>;
    expect(payload.mcpSupport).toBe(true);
  });

  it('buildCatPayload seeds default Antigravity command args when the field is still blank', () => {
    const form: HubCatEditorFormState = {
      catId: 'runtime-bridge',
      name: '桥接猫',
      displayName: '桥接猫',
      nickname: '',
      avatar: '/avatars/bridge.png',
      colorPrimary: '#16a34a',
      colorSecondary: '#bbf7d0',
      mentionPatterns: '@runtime-bridge',
      roleDescription: 'bridge',
      personality: 'steady',
      teamStrengths: '',
      caution: '',
      strengths: '',
      client: 'antigravity',
      accountRef: '',
      defaultModel: 'gemini-bridge',
      commandArgs: '',
      cliConfigArgs: [],
      ocProviderName: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
    };

    const payload = buildCatPayload(form, null) as Record<string, unknown>;
    expect(payload.commandArgs).toEqual(splitCommandArgs(DEFAULT_ANTIGRAVITY_COMMAND_ARGS));
  });

  it('splitCommandArgs preserves quoted segments', () => {
    expect(splitCommandArgs('chat --mode "agent bridge" --path "/tmp/work tree"')).toEqual([
      'chat',
      '--mode',
      'agent bridge',
      '--path',
      '/tmp/work tree',
    ]);
  });

  it('validateModelFormatForClient rejects opencode model without providerId/modelId format', () => {
    expect(validateModelFormatForClient('opencode', 'gpt-5.4')).toMatch(/providerId\/modelId/i);
    expect(validateModelFormatForClient('opencode', 'openai/gpt-5.4')).toBeNull();
    expect(validateModelFormatForClient('openai', 'gpt-5.4')).toBeNull();
  });

  it('renders normal member provider/model fields and saves to /api/cats', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/provider-profiles') {
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
                models: ['gpt-5.4-mini'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-spark' } }, 201));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    expect(container.textContent).toContain('认证信息');
    expect(container.textContent).not.toContain('CLI Command');

    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Avatar"]'), '/avatars/spark.png');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-spark, @火花猫');
    await changeField(queryField(container, 'select[aria-label="Client"]'), 'openai', 'change');
    await flushEffects();
    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'codex-sponsor', 'change');
    await changeField(queryField(container, 'input[aria-label="Model"]'), 'gpt-5.4-mini');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/cats');
    expect(postCall).toBeTruthy();
    expect(postCall?.[1]?.method).toBe('POST');
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.client).toBe('openai');
    expect(payload.catId).toMatch(/^cat-[a-z0-9]+$/);
    expect(payload.accountRef).toBe('codex-sponsor');
    expect(payload.defaultModel).toBe('gpt-5.4-mini');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('blocks creating opencode+api_key member without ocProviderName', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'opencode',
            providers: [
              {
                id: 'opencode',
                provider: 'opencode',
                displayName: 'OpenCode (OAuth)',
                name: 'OpenCode (OAuth)',
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
                id: 'oc-apikey',
                provider: 'oc-apikey',
                displayName: 'OC API Key',
                name: 'OC API Key',
                authType: 'api_key',
                builtin: false,
                mode: 'api_key',
                models: ['glm-5'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-opencode' } }, 201));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: {
            client: 'opencode',
            accountRef: 'oc-apikey',
            defaultModel: 'glm-5',
          },
          onClose: vi.fn(),
          onSaved: onSaved,
        }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '运行时金渐层');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '审查');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-jinjianceng');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    // Save should be blocked — opencode+api_key without ocProviderName is rejected.
    const postCall = mockApiFetch.mock.calls.find(([path, init]) => path === '/api/cats' && init?.method === 'POST');
    expect(postCall).toBeUndefined();
    expect(container.textContent).toContain('Provider 名称');
  });

  it('resets defaultModel when switching Provider to prevent stale model carry-over', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: null,
        providers: [
          {
            id: 'claude',
            provider: 'claude',
            displayName: 'Claude (OAuth)',
            name: 'Claude (OAuth)',
            authType: 'oauth',
            kind: 'builtin',
            builtin: true,
            client: 'anthropic',
            models: ['claude-opus-4-6', 'claude-sonnet-4-5'],
            hasApiKey: false,
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'codex-sponsor',
            provider: 'codex-sponsor',
            displayName: 'Codex Sponsor',
            name: 'Codex Sponsor',
            authType: 'api_key',
            kind: 'api_key',
            builtin: false,
            models: ['gpt-5.4-mini'],
            hasApiKey: true,
            baseUrl: 'https://proxy.example',
            createdAt: '',
            updatedAt: '',
          },
        ],
      }),
    );

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          cat: {
            id: 'opus',
            displayName: 'Opus',
            breedDisplayName: 'Ragdoll',
            nickname: '',
            provider: 'anthropic',
            accountRef: 'claude',
            defaultModel: 'claude-opus-4-6',
            color: { primary: '#000', secondary: '#fff' },
            mentionPatterns: ['@opus'],
            avatar: '',
            roleDescription: '',
            personality: '',
            source: 'seed',
          },
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();

    // Initially model should be claude-opus-4-6
    const modelInput = queryField<HTMLInputElement>(container, 'input[aria-label="Model"]');
    expect(modelInput.value).toBe('claude-opus-4-6');

    // Switch Provider to codex-sponsor (API Key)
    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'codex-sponsor', 'change');
    await flushEffects();

    // defaultModel should have been reset (not still 'claude-opus-4-6')
    const modelInputAfter = queryField<HTMLInputElement>(container, 'input[aria-label="Model"]');
    expect(modelInputAfter.value).not.toBe('claude-opus-4-6');
  });

  it('resets ocProviderName when switching account to prevent stale provider carry-over', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: null,
        providers: [
          {
            id: 'maas-key',
            provider: 'maas-key',
            displayName: 'MaaS Key',
            name: 'MaaS Key',
            authType: 'api_key',
            kind: 'api_key',
            builtin: false,
            models: ['glm-5'],
            hasApiKey: true,
            baseUrl: 'https://maas.example',
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'deepseek-key',
            provider: 'deepseek-key',
            displayName: 'DeepSeek Key',
            name: 'DeepSeek Key',
            authType: 'api_key',
            kind: 'api_key',
            builtin: false,
            models: ['deepseek-r2'],
            hasApiKey: true,
            baseUrl: 'https://deepseek.example',
            createdAt: '',
            updatedAt: '',
          },
        ],
      }),
    );

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          cat: {
            id: 'oc-maas',
            displayName: 'OC MaaS',
            breedDisplayName: 'OpenCode',
            nickname: '',
            provider: 'opencode',
            accountRef: 'maas-key',
            defaultModel: 'maas/glm-5',
            ocProviderName: 'maas',
            color: { primary: '#000', secondary: '#fff' },
            mentionPatterns: ['@oc-maas'],
            avatar: '',
            roleDescription: '',
            personality: '',
            source: 'runtime',
          } as CatData,
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();

    // Initially ocProviderName should be 'maas'
    const providerInput = queryField<HTMLInputElement>(container, 'input[aria-label="OC Provider Name"]');
    expect(providerInput.value).toBe('maas');

    // Switch account to deepseek-key
    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'deepseek-key', 'change');
    await flushEffects();

    // ocProviderName should have been cleared (not still 'maas')
    const providerInputAfter = queryField<HTMLInputElement>(container, 'input[aria-label="OC Provider Name"]');
    expect(providerInputAfter.value).toBe('');
  });

  it('switches to Antigravity branch and shows CLI command field', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: null,
        providers: [],
      }),
    );

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="Client"]'), 'antigravity', 'change');
    expect(container.textContent).toContain('CLI Command');
    expect(container.querySelector('select[aria-label="认证信息"]')).toBeNull();
  });

  it('shows the selected client builtin account together with all API key accounts', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-oauth',
            providers: [
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
                id: 'claude-sponsor',
                provider: 'claude-sponsor',
                displayName: 'Claude Sponsor',
                name: 'Claude Sponsor',
                authType: 'api_key',
                protocol: 'anthropic',
                builtin: false,
                mode: 'api_key',
                models: ['claude-opus-4-6'],
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
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="Client"]'), 'openai', 'change');
    await flushEffects();
    const providerSelect = queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]');
    const optionLabels = Array.from(providerSelect.options).map((option) => option.textContent ?? '');
    expect(optionLabels).toContain('Codex (OAuth)（内置）');
    expect(optionLabels).toContain('Claude Sponsor（API Key）');
  });

  it('keeps builtin accounts client-specific while exposing all API key accounts', () => {
    const profiles: ProfileItem[] = [
      {
        id: 'claude-oauth',
        provider: 'claude-oauth',
        displayName: 'Claude (OAuth)',
        name: 'Claude (OAuth)',
        authType: 'oauth',
        protocol: 'anthropic',
        kind: 'builtin',
        builtin: true,
        mode: 'subscription',
        models: ['claude-opus-4-6'],
        hasApiKey: false,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      },
      {
        id: 'claude-sponsor',
        provider: 'claude-sponsor',
        displayName: 'Claude Sponsor',
        name: 'Claude Sponsor',
        authType: 'api_key',
        protocol: 'anthropic',
        kind: 'api_key',
        builtin: false,
        mode: 'api_key',
        models: ['claude-opus-4-6'],
        hasApiKey: true,
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
        kind: 'builtin',
        builtin: true,
        mode: 'subscription',
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
        kind: 'api_key',
        builtin: false,
        mode: 'api_key',
        models: ['gpt-5.4'],
        hasApiKey: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      },
    ];

    expect(filterProfiles('openai', profiles).map((profile) => profile.id)).toEqual([
      'codex-oauth',
      'claude-sponsor',
      'codex-sponsor',
    ]);
    expect(filterProfiles('anthropic', profiles).map((profile) => profile.id)).toEqual([
      'claude-oauth',
      'claude-sponsor',
      'codex-sponsor',
    ]);
    expect(filterProfiles('dare', profiles).map((profile) => profile.id)).toEqual(['claude-sponsor', 'codex-sponsor']);
    expect(filterProfiles('opencode', profiles).map((profile) => profile.id)).toEqual([
      'claude-sponsor',
      'codex-sponsor',
    ]);
  });

  it('preserves existing model when it is not listed in provider defaults', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      provider: 'openai',
      providerProfileId: 'codex-oauth',
      defaultModel: 'gpt-5.3-codex-spark',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      source: 'runtime',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-oauth',
            providers: [
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
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.defaultModel).toBe('gpt-5.3-codex-spark');
  });

  it('keeps unbound cats unbound when opening the editor', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      provider: 'openai',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      source: 'runtime',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-oauth',
            providers: [
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
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]').value).toBe('');

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.accountRef).toBeUndefined();
  });

  it('keeps unbound opencode members unbound until a provider is chosen', async () => {
    const existingCat = {
      id: 'runtime-opencode',
      name: 'runtime-opencode',
      displayName: '运行时 OpenCode',
      provider: 'opencode',
      defaultModel: 'claude-opus-4-6',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-opencode'],
      avatar: '/avatars/opencode.png',
      roleDescription: 'review',
      source: 'runtime',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
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
                id: 'claude-sponsor',
                provider: 'claude-sponsor',
                displayName: 'Claude Sponsor',
                name: 'Claude Sponsor',
                authType: 'api_key',
                protocol: 'anthropic',
                builtin: false,
                mode: 'api_key',
                models: ['claude-opus-4-6'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cats/runtime-opencode' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-opencode' } }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]').value).toBe('');

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-opencode' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.accountRef).toBeUndefined();
  });

  it('allows saving existing opencode members while provider profiles are still loading', async () => {
    const existingCat = {
      id: 'runtime-opencode',
      name: 'runtime-opencode',
      displayName: '运行时 OpenCode',
      provider: 'opencode',
      defaultModel: 'claude-opus-4-6',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-opencode'],
      avatar: '/avatars/opencode.png',
      roleDescription: 'review',
      source: 'runtime',
    } as CatData;

    let resolveProfiles!: (value: Response) => void;
    const profilesPromise = new Promise<Response>((resolve) => {
      resolveProfiles = resolve;
    });

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return profilesPromise;
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cats/runtime-opencode' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-opencode' } }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    expect(saveButton).toBeTruthy();
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    expect(
      mockApiFetch.mock.calls.find(([path, init]) => path === '/api/cats/runtime-opencode' && init?.method === 'PATCH'),
    ).toBeTruthy();

    resolveProfiles(
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
            id: 'claude-sponsor',
            provider: 'claude-sponsor',
            displayName: 'Claude Sponsor',
            name: 'Claude Sponsor',
            authType: 'api_key',
            protocol: 'anthropic',
            builtin: false,
            mode: 'api_key',
            models: ['claude-opus-4-6'],
            hasApiKey: true,
            createdAt: '2026-03-18T00:00:00.000Z',
            updatedAt: '2026-03-18T00:00:00.000Z',
          },
        ],
      }),
    );
    await flushEffects();
    await flushEffects();

    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]').value).toBe('');
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends accountRef=null when clearing an existing provider binding', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      provider: 'openai',
      providerProfileId: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      source: 'runtime',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="认证信息"]'), '', 'change');

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.accountRef).toBeNull();
  });

  it('sends accountRef=null when switching a bound member to antigravity', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      provider: 'openai',
      providerProfileId: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      source: 'runtime',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="Client"]'), 'antigravity', 'change');
    await changeField(queryField(container, 'input[aria-label="Model"]'), 'gemini-bridge');
    await changeField(queryField(container, 'input[aria-label="CLI Command"]'), 'chat --mode agent');

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.client).toBe('antigravity');
    expect(payload.accountRef).toBeNull();
    expect(payload.mcpSupport).toBe(false);
  });

  it('sends contextBudget=null when clearing existing runtime budget', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      provider: 'openai',
      providerProfileId: 'codex-oauth',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      source: 'runtime',
      contextBudget: {
        maxPromptTokens: 32000,
        maxContextTokens: 24000,
        maxMessages: 40,
        maxContentLengthPerMsg: 8000,
      },
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-oauth',
            providers: [
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
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Max Prompt Tokens"]'), '');
    await changeField(queryField(container, 'input[aria-label="Max Context Tokens"]'), '');
    await changeField(queryField(container, 'input[aria-label="Max Messages"]'), '');
    await changeField(queryField(container, 'input[aria-label="Max Content Length Per Msg"]'), '');

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.contextBudget).toBeNull();
  });

  it('requires all runtime budget fields when any budget value is provided', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                models: ['gpt-5.4-mini'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-spark' } }, 201));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();

    expect(container.textContent).toContain('4 项要么全部留空，要么全部填写');

    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Avatar"]'), '/avatars/spark.png');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-spark, @火花猫');
    await changeField(queryField(container, 'select[aria-label="Client"]'), 'openai', 'change');
    await flushEffects();
    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'codex-sponsor', 'change');
    await changeField(queryField(container, 'input[aria-label="Model"]'), 'gpt-5.4-mini');
    await changeField(queryField(container, 'input[aria-label="Max Prompt Tokens"]'), '48000');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain('上下文预算要么全部留空，要么 4 项都填写');
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/cats', expect.objectContaining({ method: 'POST' }));
  });

  it('deletes an existing member only after confirmation', async () => {
    const existingCat: CatData = {
      id: 'runtime-antigravity',
      name: '运行时桥接猫',
      displayName: '运行时桥接猫',
      provider: 'antigravity',
      defaultModel: 'gemini-bridge',
      commandArgs: ['chat', '--mode', 'agent'],
      color: { primary: '#0f766e', secondary: '#99f6e4' },
      mentionPatterns: ['@runtime-antigravity'],
      avatar: '/avatars/antigravity.png',
      roleDescription: '桥接通道',
      personality: '稳定',
      source: 'runtime',
    };
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', activeProfileId: null, providers: [] }));
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cats/runtime-antigravity') {
        return Promise.resolve(jsonResponse({ deleted: true }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    const deleteButton = queryField<HTMLButtonElement>(container, 'button[aria-label="删除成员"]');
    mockConfirm.mockResolvedValueOnce(false);

    await act(async () => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      '/api/cats/runtime-antigravity',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(onSaved).toHaveBeenCalledTimes(0);

    mockConfirm.mockResolvedValueOnce(true);
    await act(async () => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/cats/runtime-antigravity',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('prompts before closing when there are unsaved edits', async () => {
    const onClose = vi.fn();
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: null,
        providers: [],
      }),
    );

    mockConfirm.mockResolvedValue(false);
    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose, onSaved: vi.fn() }));
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '临时名字');

    const cancelButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '取消',
    );
    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockConfirm).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    mockConfirm.mockResolvedValue(true);
    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(onClose).toHaveBeenCalledTimes(1);
    mockConfirm.mockResolvedValue(true);
  });

  it('hides delete action for seed members', async () => {
    const existingCat: CatData = {
      id: 'codex',
      name: '缅因猫',
      displayName: '缅因猫',
      provider: 'openai',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      personality: 'rigorous',
      source: 'seed',
    };

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', activeProfileId: null, providers: [] }));
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    expect(container.querySelector('button[aria-label="删除成员"]')).toBeNull();
  });

  it('loads runtime controls for an existing member and saves strategy separately', async () => {
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '砚砚',
      provider: 'openai',
      providerProfileId: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex', '@缅因猫'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      personality: 'rigorous',
      teamStrengths: '代码审查、找 bug',
      caution: null,
      strengths: ['security', 'testing'],
      sessionChain: true,
      contextBudget: {
        maxPromptTokens: 32000,
        maxContextTokens: 24000,
        maxMessages: 40,
        maxContentLengthPerMsg: 8000,
      },
    } as CatData & {
      contextBudget: {
        maxPromptTokens: number;
        maxContextTokens: number;
        maxMessages: number;
        maxContentLengthPerMsg: number;
      };
    };

    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'codex',
                displayName: '缅因猫',
                provider: 'openai',
                effective: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                source: 'runtime_override',
                hasOverride: true,
                override: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                hybridCapable: false,
                sessionChainEnabled: true,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              coCreator: {
                name: 'Co-worker',
                aliases: ['共创伙伴'],
                mentionPatterns: ['@co-worker', '@owner'],
              },
              cats: {},
              perCatBudgets: {},
              a2a: { enabled: true, maxDepth: 2 },
              memory: { enabled: true, maxKeysPerThread: 50 },
              hindsight: {
                enabled: true,
                baseUrl: 'http://localhost:18888',
                sharedBank: 'cat-cafe-shared',
              },
              governance: { degradationEnabled: true, doneTimeoutMs: 300000, heartbeatIntervalMs: 30000 },
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                model: 'gpt-5.4',
                authMode: 'oauth',
                passModelArg: true,
              },
            },
          }),
        );
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/config/session-strategy/codex' && init?.method === 'PATCH') {
        return Promise.resolve(
          jsonResponse({
            catId: 'codex',
            effective: {
              strategy: 'handoff',
              thresholds: { warn: 0.55, action: 0.8 },
            },
            source: 'runtime_override',
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    expect(container.textContent).toContain('昵称');
    expect(container.textContent).toContain('擅长领域');
    expect(container.textContent).toContain('注意事项');
    expect(container.textContent).toContain('Strengths');
    expect(container.textContent).toContain('▸ Voice Config (点击展开)');
    expect(container.textContent).toContain('别名与 @ 路由');
    expect(container.textContent).toContain('认证与模型');
    expect(container.textContent).toContain('Session Chain');
    expect(container.textContent).toContain('── Codex 专属 (仅 Client=Codex 时显示) ──');
    expect(container.textContent).toContain('Codex Sandbox (Codex)');
    expect(container.textContent).toContain('Codex Approval (Codex)');
    expect(container.textContent).toContain('Codex Auth Mode (Codex)');
    expect(container.textContent).not.toContain('这 3 项是全局运行参数（非成员级）');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Sandbox"]').disabled).toBe(false);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Approval"]').disabled).toBe(false);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Auth Mode"]').disabled).toBe(false);
    expect(container.textContent).toContain('运行时持久化');
    expect(container.textContent).toContain('保存修改');
    expect(container.textContent).not.toContain('删除成员');
    expect(container.textContent).not.toContain('账号与运行方式');
    expect(container.textContent).not.toContain('Primary');
    expect(container.textContent).not.toContain('Secondary');
    expect(container.textContent).not.toContain('Display Name');

    await changeField(queryField(container, 'input[aria-label="Max Prompt Tokens"]'), '48000');
    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '砚砚升级版');
    await changeField(queryField(container, 'input[aria-label="Team Strengths"]'), '代码审查、找 bug、深度思考');
    await changeField(queryField(container, 'input[aria-label="Strengths"]'), 'security, testing, debugging');
    await changeField(queryField(container, 'select[aria-label="Session Chain"]'), 'false', 'change');
    await changeField(queryField(container, 'select[aria-label="Session Strategy"]'), 'handoff', 'change');
    await changeField(queryField(container, 'input[aria-label="Session Warn Threshold"]'), '0.55', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'danger-full-access', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Approval"]'), 'never', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Auth Mode"]'), 'api_key', 'change');

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatch).toBeTruthy();
    const catPayload = JSON.parse(String(catPatch?.[1]?.body));
    expect(catPayload.contextBudget.maxPromptTokens).toBe(48000);
    expect(catPayload.nickname).toBe('砚砚升级版');
    expect(catPayload.teamStrengths).toBe('代码审查、找 bug、深度思考');
    expect(catPayload.strengths).toEqual(['security', 'testing', 'debugging']);
    expect(catPayload.sessionChain).toBe(false);

    const strategyPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/config/session-strategy/codex' && init?.method === 'PATCH',
    );
    expect(strategyPatch).toBeTruthy();
    const strategyPayload = JSON.parse(String(strategyPatch?.[1]?.body));
    expect(strategyPayload.strategy).toBe('handoff');
    expect(strategyPayload.thresholds.warn).toBe(0.55);

    const codexConfigPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config' && init?.method === 'PATCH',
    );
    expect(codexConfigPatches).toHaveLength(3);
    expect(String(codexConfigPatches[0]?.[1]?.body)).toContain('cli.codexSandboxMode');
    expect(String(codexConfigPatches[0]?.[1]?.body)).toContain('danger-full-access');
    expect(String(codexConfigPatches[1]?.[1]?.body)).toContain('cli.codexApprovalPolicy');
    expect(String(codexConfigPatches[1]?.[1]?.body)).toContain('never');
    expect(String(codexConfigPatches[2]?.[1]?.body)).toContain('codex.execution.authMode');
    expect(String(codexConfigPatches[2]?.[1]?.body)).toContain('api_key');
  });

  it('does not write session-strategy override when strategy fields are unchanged', async () => {
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      provider: 'openai',
      providerProfileId: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex', '@缅因猫'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      sessionChain: true,
      contextBudget: {
        maxPromptTokens: 32000,
        maxContextTokens: 24000,
        maxMessages: 40,
        maxContentLengthPerMsg: 8000,
      },
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'codex',
                displayName: '缅因猫',
                provider: 'openai',
                effective: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                source: 'breed',
                hasOverride: false,
                hybridCapable: false,
                sessionChainEnabled: true,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: { codexSandboxMode: 'workspace-write', codexApprovalPolicy: 'on-request' },
              codexExecution: { authMode: 'oauth' },
            },
          }),
        );
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/config/session-strategy/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '砚砚');

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatch).toBeTruthy();
    const strategyPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/config/session-strategy/codex' && init?.method === 'PATCH',
    );
    expect(strategyPatch).toBeFalsy();
  });

  it('shows Codex-only runtime controls for any Client=Codex and lets alias chips be removed', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'danger-full-access',
                codexApprovalPolicy: 'never',
              },
              codexExecution: {
                authMode: 'api_key',
              },
            },
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-reviewer' } }, 201));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '运行时审查猫');
    await changeField(queryField(container, 'input[aria-label="Description"]'), 'review');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-reviewer, @第二别名');
    await changeField(queryField(container, 'select[aria-label="Client"]'), 'openai', 'change');
    await flushEffects();

    expect(container.textContent).toContain('Codex Sandbox (Codex)');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Sandbox"]').value).toBe(
      'danger-full-access',
    );
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Approval"]').value).toBe('never');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Auth Mode"]').value).toBe('api_key');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Sandbox"]').disabled).toBe(false);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Approval"]').disabled).toBe(false);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Auth Mode"]').disabled).toBe(false);

    const removeAliasButton = queryField<HTMLButtonElement>(container, 'button[aria-label="移除 @第二别名"]');
    await act(async () => {
      removeAliasButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'codex-sponsor', 'change');
    await changeField(queryField(container, 'input[aria-label="Model"]'), 'gpt-5.4');
    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'workspace-write', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Approval"]'), 'on-request', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Auth Mode"]'), 'oauth', 'change');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/cats');
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.mentionPatterns).toEqual(['@runtime-reviewer']);
    const codexConfigPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config' && init?.method === 'PATCH',
    );
    expect(codexConfigPatches).toHaveLength(3);
    expect(String(codexConfigPatches[0]?.[1]?.body)).toContain('cli.codexSandboxMode');
    expect(String(codexConfigPatches[1]?.[1]?.body)).toContain('cli.codexApprovalPolicy');
    expect(String(codexConfigPatches[2]?.[1]?.body)).toContain('codex.execution.authMode');
  });

  it('surfaces an error when a Codex runtime PATCH fails', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      provider: 'openai',
      providerProfileId: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      source: 'runtime',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                authMode: 'oauth',
              },
            },
          }),
        );
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ error: 'Codex PATCH failed' }, 500));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'danger-full-access', 'change');

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain('Codex PATCH failed');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('disables Codex-only fields and skips Codex PATCHes when baseline loading fails', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '旧昵称',
      provider: 'openai',
      providerProfileId: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      source: 'runtime',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(new Response('{}', { status: 503 }));
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    expect(container.textContent).toContain('Codex 运行参数加载失败 (503)');
    expect(container.textContent).toContain('Codex 配置基线未加载成功');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Sandbox"]').disabled).toBe(true);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Approval"]').disabled).toBe(true);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Auth Mode"]').disabled).toBe(true);

    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '新昵称');

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatch).toBeTruthy();

    const codexConfigPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config' && init?.method === 'PATCH',
    );
    expect(codexConfigPatches).toHaveLength(0);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('rolls back the cat PATCH when a Codex runtime PATCH fails after the member save succeeds', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '旧昵称',
      provider: 'openai',
      providerProfileId: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      source: 'runtime',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                authMode: 'oauth',
              },
            },
          }),
        );
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ error: 'Codex PATCH failed' }, 500));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '新昵称');
    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'danger-full-access', 'change');

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatches).toHaveLength(2);

    const firstPayload = JSON.parse(String(catPatches[0]?.[1]?.body));
    expect(firstPayload.nickname).toBe('新昵称');

    const rollbackPayload = JSON.parse(String(catPatches[1]?.[1]?.body));
    expect(rollbackPayload.nickname).toBe('旧昵称');
    expect(rollbackPayload.defaultModel).toBe('gpt-5.4');
    expect(rollbackPayload.accountRef).toBe('codex-sponsor');
    expect(container.textContent).toContain('Codex PATCH failed');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('rolls back prior strategy and config mutations when a later Codex config PATCH fails', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '旧昵称',
      provider: 'openai',
      providerProfileId: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      source: 'runtime',
    } as CatData;

    let configPatchCount = 0;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'codex',
                displayName: '缅因猫',
                provider: 'openai',
                effective: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                source: 'runtime_override',
                hasOverride: true,
                override: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                hybridCapable: false,
                sessionChainEnabled: true,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                authMode: 'oauth',
              },
            },
          }),
        );
      }
      if (path === '/api/config/session-strategy/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        configPatchCount += 1;
        if (configPatchCount === 2) {
          return Promise.resolve(jsonResponse({ error: 'Second Codex PATCH failed' }, 500));
        }
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '新昵称');
    await changeField(queryField(container, 'select[aria-label="Session Strategy"]'), 'handoff', 'change');
    await changeField(queryField(container, 'input[aria-label="Session Warn Threshold"]'), '0.55');
    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'danger-full-access', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Approval"]'), 'never', 'change');

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const strategyPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config/session-strategy/codex' && init?.method === 'PATCH',
    );
    expect(strategyPatches).toHaveLength(2);
    expect(JSON.parse(String(strategyPatches[0]?.[1]?.body)).strategy).toBe('handoff');
    const strategyRollbackPayload = JSON.parse(String(strategyPatches[1]?.[1]?.body));
    expect(strategyRollbackPayload.strategy).toBe('compress');
    expect(strategyRollbackPayload.thresholds.warn).toBe(0.6);

    const configPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config' && init?.method === 'PATCH',
    );
    expect(configPatches.length).toBeGreaterThanOrEqual(3);
    expect(
      configPatches.some(
        ([, init]) =>
          String(init?.body).includes('cli.codexSandboxMode') && String(init?.body).includes('workspace-write'),
      ),
    ).toBe(true);

    const catPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatches).toHaveLength(2);
    const rollbackPayload = JSON.parse(String(catPatches[1]?.[1]?.body));
    expect(rollbackPayload.nickname).toBe('旧昵称');
    expect(container.textContent).toContain('Second Codex PATCH failed');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('rolls back already-applied strategy mutations when later save requests throw', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '旧昵称',
      provider: 'openai',
      providerProfileId: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      source: 'runtime',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/provider-profiles') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                builtin: false,
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'codex',
                displayName: '缅因猫',
                provider: 'openai',
                effective: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                source: 'runtime_override',
                hasOverride: true,
                override: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                hybridCapable: false,
                sessionChainEnabled: true,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                authMode: 'oauth',
              },
            },
          }),
        );
      }
      if (path === '/api/config/session-strategy/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.reject(new Error('network dropped during cat save'));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="Session Strategy"]'), 'handoff', 'change');
    await changeField(queryField(container, 'input[aria-label="Session Warn Threshold"]'), '0.55');

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '保存修改',
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const strategyPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config/session-strategy/codex' && init?.method === 'PATCH',
    );
    expect(strategyPatches).toHaveLength(2);
    expect(JSON.parse(String(strategyPatches[0]?.[1]?.body)).strategy).toBe('handoff');
    expect(JSON.parse(String(strategyPatches[1]?.[1]?.body)).strategy).toBe('compress');
    expect(container.textContent).toContain('network dropped during cat save');
    expect(onSaved).not.toHaveBeenCalled();
  });
});
