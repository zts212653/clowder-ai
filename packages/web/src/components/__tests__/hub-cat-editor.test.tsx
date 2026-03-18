import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

import { HubCatEditor } from '@/components/HubCatEditor';

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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
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

    expect(container.textContent).toContain('Provider');
    expect(container.textContent).not.toContain('CLI Command');

    await changeField(queryField(container, 'input[aria-label="Cat ID"]'), 'runtime-spark');
    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Display Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Avatar"]'), '/avatars/spark.png');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-spark, @火花猫');
    await changeField(queryField(container, 'select[aria-label="Client"]'), 'openai', 'change');
    await flushEffects();
    await changeField(queryField(container, 'select[aria-label="Provider"]'), 'codex-sponsor', 'change');
    await changeField(queryField(container, 'select[aria-label="Model"]'), 'gpt-5.4-mini', 'change');

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
    expect(payload.catId).toBe('runtime-spark');
    expect(payload.providerProfileId).toBe('codex-sponsor');
    expect(payload.defaultModel).toBe('gpt-5.4-mini');
    expect(onSaved).toHaveBeenCalledTimes(1);
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
    expect(container.querySelector('select[aria-label="Provider"]')).toBeNull();
  });

  it('deletes an existing member through the delete action', async () => {
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

    const deleteButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '删除成员');
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/cats/runtime-antigravity', expect.objectContaining({ method: 'DELETE' }));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('loads runtime controls for an existing member and saves strategy separately', async () => {
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
      personality: 'rigorous',
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
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
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

    expect(container.textContent).toContain('Max Prompt Tokens');
    expect(container.textContent).toContain('Session Strategy');

    await changeField(queryField(container, 'input[aria-label="Max Prompt Tokens"]'), '48000');
    await changeField(queryField(container, 'select[aria-label="Session Strategy"]'), 'handoff', 'change');
    await changeField(queryField(container, 'input[aria-label="Warn Threshold"]'), '0.55');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatch = mockApiFetch.mock.calls.find(([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH');
    expect(catPatch).toBeTruthy();
    const catPayload = JSON.parse(String(catPatch?.[1]?.body));
    expect(catPayload.contextBudget.maxPromptTokens).toBe(48000);

    const strategyPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/config/session-strategy/codex' && init?.method === 'PATCH',
    );
    expect(strategyPatch).toBeTruthy();
    const strategyPayload = JSON.parse(String(strategyPatch?.[1]?.body));
    expect(strategyPayload.strategy).toBe('handoff');
    expect(strategyPayload.thresholds.warn).toBe(0.55);
  });
});
