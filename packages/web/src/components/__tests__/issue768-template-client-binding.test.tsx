/**
 * clowder-ai#768 P2/P3: picking a role template must bind the client that template
 * recommends, and that client's template defaults must supply the model — otherwise
 * a template-bound member is created against the wrong client or with no model at all.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

vi.mock('@/components/useConfirm', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
}));

import { ClientStep, type DetectedClient } from '@/components/first-run-quest/ClientStep';
import type { TemplateCard } from '@/components/first-run-quest/TemplateStep';
import { HubCatEditor } from '@/components/HubCatEditor';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function queryField<T extends HTMLElement>(selector: string): T {
  const element = document.body.querySelector(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element as T;
}

const BENGAL: TemplateCard = {
  id: 'bengal',
  name: '孟加拉猫',
  nickname: '斑斑',
  avatar: '/avatars/antigravity.png',
  color: { primary: '#D4853A', secondary: '#FAEBDB' },
  roleDescription: '混血多模型 agent',
  personality: '精力旺盛',
  defaultClient: 'antigravity',
};

const RAGDOLL: TemplateCard = {
  id: 'ragdoll',
  name: '布偶猫',
  nickname: '宪宪',
  avatar: '/avatars/opus.png',
  color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
  roleDescription: '主架构师',
  personality: '温柔但有主见',
  defaultClient: 'anthropic',
};

const ANTHROPIC_ACCOUNT = {
  id: 'claude',
  displayName: 'Claude',
  name: 'claude',
  authType: 'oauth',
  kind: 'builtin',
  builtin: true,
  mode: 'subscription',
  clientId: 'anthropic',
  models: ['claude-sonnet-4-6'],
  hasApiKey: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function mockTemplatesEndpoint(
  templates: TemplateCard[],
  clientDefaults: Record<string, unknown>,
  providers: unknown[] = [],
) {
  mockApiFetch.mockImplementation((path: string) => {
    if (path === '/api/accounts') {
      return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', activeProfileId: null, providers }));
    }
    if (path === '/api/cat-templates') {
      return Promise.resolve(jsonResponse({ templates, clientDefaults }));
    }
    throw new Error(`Unexpected apiFetch path: ${path}`);
  });
}

async function clickTemplate(nickname: string) {
  const button = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === nickname);
  if (!button) throw new Error(`Missing template button: ${nickname}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flushEffects();
}

async function selectClient(value: string) {
  const select = queryField<HTMLSelectElement>('select[aria-label="Client"]');
  await act(async () => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    nativeSetter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flushEffects();
}

async function selectAccount(value: string) {
  const select = queryField<HTMLSelectElement>('select[aria-label="认证信息"]');
  await act(async () => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    nativeSetter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flushEffects();
}

async function typeModel(value: string) {
  const input = queryField<HTMLInputElement>('input[aria-label="Model"]');
  await act(async () => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    nativeSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flushEffects();
}

async function selectTransport(value: string) {
  const select = queryField<HTMLSelectElement>('select[aria-label="Transport"]');
  await act(async () => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    nativeSetter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flushEffects();
}

describe('#768: template selection binds the recommended client', () => {
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

  async function openEditor() {
    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();
  }

  it('binds the template client and fills that client default model (Antigravity has no account model list)', async () => {
    mockTemplatesEndpoint([BENGAL], {
      antigravity: { defaultModel: 'gemini-3.1-pro', models: ['gemini-3.1-pro', 'claude-opus-4-6'] },
    });
    await openEditor();
    await clickTemplate('斑斑');

    expect(queryField<HTMLSelectElement>('select[aria-label="Client"]').value).toBe('antigravity');
    expect(queryField<HTMLInputElement>('input[aria-label="Model"]').value).toBe('gemini-3.1-pro');
  });

  it('reads legacy product-name clientDefaults keys from pre-#768 project templates', async () => {
    mockTemplatesEndpoint([RAGDOLL], {
      claude: { defaultModel: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'] },
    });
    await openEditor();
    await clickTemplate('宪宪');

    expect(queryField<HTMLSelectElement>('select[aria-label="Client"]').value).toBe('anthropic');
    expect(queryField<HTMLInputElement>('input[aria-label="Model"]').value).toBe('claude-sonnet-4-6');
  });

  it('keeps the current client when a template recommends one this editor cannot bind', async () => {
    mockTemplatesEndpoint([{ ...RAGDOLL, defaultClient: 'a2a' }], {
      anthropic: { defaultModel: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'] },
    });
    await openEditor();
    const clientBefore = queryField<HTMLSelectElement>('select[aria-label="Client"]').value;
    await clickTemplate('宪宪');

    expect(queryField<HTMLSelectElement>('select[aria-label="Client"]').value).toBe(clientBefore);
    // Persona fields still applied — an unbindable recommendation must not block template use.
    expect(queryField<HTMLInputElement>('input[aria-label="Name"]').value).toBe('布偶猫');
  });
  it('drops the template model when the user then switches client by hand', async () => {
    mockTemplatesEndpoint([RAGDOLL], {
      anthropic: { defaultModel: 'claude-opus-4-7', models: ['claude-opus-4-7'] },
      openai: { defaultModel: 'gpt-5.6-sol', models: ['gpt-5.6-sol'] },
    });
    await openEditor();
    await clickTemplate('宪宪');
    expect(queryField<HTMLInputElement>('input[aria-label="Model"]').value).toBe('claude-opus-4-7');

    await selectClient('openai');

    // The model belongs to the client it was picked for. Switching client must
    // re-derive it, never carry the anthropic model onto an openai member.
    expect(queryField<HTMLSelectElement>('select[aria-label="Client"]').value).toBe('openai');
    expect(queryField<HTMLInputElement>('input[aria-label="Model"]').value).toBe('gpt-5.6-sol');
  });

  it('normalizes hidden transport state when the template switches client', async () => {
    mockTemplatesEndpoint([RAGDOLL], {
      anthropic: { defaultModel: 'claude-opus-4-7', models: ['claude-opus-4-7'] },
      opencode: { defaultModel: 'glm-5.2', models: ['glm-5.2'] },
    });
    await openEditor();
    await selectClient('opencode');
    await selectTransport('acp');
    expect(document.body.querySelector('input[aria-label="ACP Command"]')).toBeTruthy();

    await clickTemplate('宪宪');

    // anthropic has no transport selector, so a surviving acpEnabled would be invisible
    // in the form yet still persisted by buildAcpPatch().
    expect(queryField<HTMLSelectElement>('select[aria-label="Client"]').value).toBe('anthropic');
    expect(document.body.querySelector('select[aria-label="Transport"]')).toBeNull();
    expect(document.body.querySelector('input[aria-label="ACP Command"]')).toBeNull();
  });

  it('re-resolves the model across account, then client, then template in turn', async () => {
    // The ordering cross-family review asked for: 先选账号 / 手动切 client / 再选模板.
    mockTemplatesEndpoint(
      [RAGDOLL],
      {
        anthropic: { defaultModel: 'claude-opus-4-7', models: ['claude-opus-4-7'] },
        openai: { defaultModel: 'gpt-5.6-sol', models: ['gpt-5.6-sol'] },
      },
      [ANTHROPIC_ACCOUNT],
    );
    await openEditor();

    // 1. Account first: the account's own list outranks the template default, so the
    //    saved model is one the account actually serves.
    await selectAccount('claude');
    expect(queryField<HTMLInputElement>('input[aria-label="Model"]').value).toBe('claude-sonnet-4-6');

    // 2. Manual client switch: the anthropic model must not follow to openai, which
    //    has no account here and so falls back to its template default.
    await selectClient('openai');
    expect(queryField<HTMLInputElement>('input[aria-label="Model"]').value).toBe('gpt-5.6-sol');

    // 3. Template last: it binds anthropic, and the account serving anthropic supplies
    //    the model instead of the template default — never the stale openai-era value.
    await clickTemplate('宪宪');
    expect(queryField<HTMLSelectElement>('select[aria-label="Client"]').value).toBe('anthropic');
    expect(queryField<HTMLInputElement>('input[aria-label="Model"]').value).toBe('claude-sonnet-4-6');
  });

  it('keeps the account model when the template recommends the client already selected', async () => {
    // Cross-family review + cloud codex converged here. The ordering test above only
    // passes because it detours through openai: that moves the (client, account) scope,
    // so the resolution effect re-runs and repairs the value. With no client change in
    // between, neither the scope nor `modelOptions` moves, the effect never runs, and
    // template selection is the only thing that can honour the account.
    mockTemplatesEndpoint([RAGDOLL], { anthropic: { defaultModel: 'claude-opus-4-7', models: ['claude-opus-4-7'] } }, [
      ANTHROPIC_ACCOUNT,
    ]);
    await openEditor();

    await selectAccount('claude');
    expect(queryField<HTMLInputElement>('input[aria-label="Model"]').value).toBe('claude-sonnet-4-6');

    // RAGDOLL recommends anthropic — the client already in the form.
    await clickTemplate('宪宪');

    expect(queryField<HTMLSelectElement>('select[aria-label="Client"]').value).toBe('anthropic');
    expect(queryField<HTMLInputElement>('input[aria-label="Model"]').value).toBe('claude-sonnet-4-6');
  });

  it('keeps a model the user chose when a same-client template does not move the scope', async () => {
    // Cross-family review of 4ba1695da: that fix passed `scopeChanged: true` from this
    // path, which forced re-resolution to accountModels[0] and silently replaced a model
    // the user had picked. The scope is (client, account) -- a template that keeps the
    // client moves neither of them, so picking one is not an invalidation.
    mockTemplatesEndpoint([RAGDOLL], { anthropic: { defaultModel: 'claude-opus-4-7', models: ['claude-opus-4-7'] } }, [
      { ...ANTHROPIC_ACCOUNT, models: ['claude-sonnet-4-6', 'claude-opus-4-6'] },
    ]);
    await openEditor();

    await selectAccount('claude');
    await typeModel('claude-opus-4-6');
    expect(queryField<HTMLInputElement>('input[aria-label="Model"]').value).toBe('claude-opus-4-6');

    await clickTemplate('宪宪');

    expect(queryField<HTMLSelectElement>('select[aria-label="Client"]').value).toBe('anthropic');
    expect(queryField<HTMLInputElement>('input[aria-label="Model"]').value).toBe('claude-opus-4-6');
  });

  it('applies the template default when the same-client account lists no models', async () => {
    // The account-first rule must not strand a model-less member: an account with no
    // catalog (API-key accounts, Antigravity) still needs the template default.
    mockTemplatesEndpoint([RAGDOLL], { anthropic: { defaultModel: 'claude-opus-4-7', models: ['claude-opus-4-7'] } }, [
      { ...ANTHROPIC_ACCOUNT, models: [] },
    ]);
    await openEditor();

    await selectAccount('claude');
    await clickTemplate('宪宪');

    expect(queryField<HTMLSelectElement>('select[aria-label="Client"]').value).toBe('anthropic');
    expect(queryField<HTMLInputElement>('input[aria-label="Model"]').value).toBe('claude-opus-4-7');
  });
});

describe('#768: first-run client step surfaces the template recommendation', () => {
  let container: HTMLDivElement;
  let root: Root;

  const detected = (provider: string, label: string, installed = true): DetectedClient => ({
    client: label.toLowerCase(),
    provider,
    label,
    cli: label.toLowerCase(),
    installed,
    hasApiKey: false,
  });

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
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

  async function renderClientStep(recommendedClient?: string, clients: DetectedClient[] = []) {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/first-run/available-clients') return Promise.resolve(jsonResponse({ clients }));
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });
    await act(async () => {
      root.render(React.createElement(ClientStep, { onSelect: vi.fn(), recommendedClient }));
    });
    await flushEffects();
  }

  it('labels the recommended client and lists it first', async () => {
    await renderClientStep('opencode', [
      detected('anthropic', 'Claude'),
      detected('opencode', 'OpenCode'),
      detected('openai', 'Codex'),
    ]);

    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels[0]).toContain('OpenCode');
    expect(labels[0]).toContain('模板推荐');
    expect(labels[1]).not.toContain('模板推荐');
  });

  it('says so when the recommended client is not detectable on this machine', async () => {
    await renderClientStep('antigravity', [detected('anthropic', 'Claude')]);

    expect(container.textContent).toContain('antigravity');
    expect(container.textContent).toContain('创建成员后可在成员设置里切换');
  });

  it('flags the recommendation when the detected client is not installed', async () => {
    await renderClientStep('opencode', [detected('anthropic', 'Claude'), detected('opencode', 'OpenCode', false)]);

    // Detected-but-uninstalled is not a usable recommendation: say so, and mark which
    // entry it refers to, instead of silently offering arbitrary installed clients.
    expect(container.textContent).toContain('创建成员后可在成员设置里切换');
    expect(container.textContent).toContain('模板推荐');
  });

  it('stays quiet when no template recommendation is available', async () => {
    await renderClientStep(undefined, [detected('anthropic', 'Claude')]);

    expect(container.textContent).not.toContain('模板推荐');
  });
});
