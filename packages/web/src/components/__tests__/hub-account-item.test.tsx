import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubAccountItem, type ProfileEditPayload } from '@/components/HubAccountItem';
import type { ProfileItem } from '@/components/hub-accounts.types';

const mockConfirm = vi.fn().mockResolvedValue(true);
vi.mock('@/components/useConfirm', () => ({
  useConfirm: () => mockConfirm,
}));

function queryButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) {
    throw new Error(`Missing button: ${text}`);
  }
  return button as HTMLButtonElement;
}

describe('HubAccountItem', () => {
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('does not clear modelOverride when saving edit without override changes', async () => {
    const profile: ProfileItem = {
      id: 'claude-api',
      provider: 'claude-api',
      displayName: 'Claude API',
      name: 'Claude API',
      authType: 'api_key',
      protocol: 'anthropic',
      kind: 'api_key',
      builtin: false,
      mode: 'api_key',
      baseUrl: 'https://api.anthropic.com',
      models: ['claude-opus-4-1'],
      modelOverride: 'claude-opus-4-1',
      hasApiKey: true,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    };
    const onSave = vi.fn<(profileId: string, payload: ProfileEditPayload) => Promise<void>>(async () => {});

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={onSave} onDelete={() => {}} />);
    });

    await act(async () => {
      queryButton(container, '编辑').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      queryButton(container, '保存').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]![1] as ProfileEditPayload;
    expect(payload).toMatchObject({
      displayName: 'Claude API',
      baseUrl: 'https://api.anthropic.com',
      models: ['claude-opus-4-1'],
    });
    expect(Object.hasOwn(payload, 'modelOverride')).toBe(false);
  });

  // F340: Protocol editing test removed — protocol is now derived at runtime, no UI for it.

  it('sends empty baseUrl when clearing an API-key account base URL', async () => {
    const profile: ProfileItem = {
      id: 'codex-api',
      provider: 'codex-api',
      displayName: 'Codex API',
      name: 'Codex API',
      authType: 'api_key',
      protocol: 'openai',
      kind: 'api_key',
      builtin: false,
      mode: 'api_key',
      baseUrl: 'https://api.openai-proxy.dev',
      models: ['gpt-5.4'],
      hasApiKey: true,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    };
    const onSave = vi.fn<(profileId: string, payload: ProfileEditPayload) => Promise<void>>(async () => {});

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={onSave} onDelete={() => {}} />);
    });

    await act(async () => {
      queryButton(container, '编辑').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const baseUrlInput = container.querySelector('input[placeholder*="API 服务地址"]') as HTMLInputElement | null;
    if (!baseUrlInput) throw new Error('Missing Base URL input');
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(baseUrlInput), 'value');
      descriptor?.set?.call(baseUrlInput, '');
      baseUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      queryButton(container, '保存').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]![1] as ProfileEditPayload;
    expect(payload.baseUrl).toBe('');
  });

  it('keeps the + 添加 model entry visible for built-in cards without binding-scope controls', async () => {
    const profile: ProfileItem = {
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
    };

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.textContent).toContain('+ 添加');
    expect(container.textContent).not.toContain('编辑');
    expect(container.textContent).not.toContain('绑定范围');
    expect(container.textContent).not.toContain('设为 Codex 默认');
  });

  it('hides unsupported 测试 actions for non-api-key profiles', async () => {
    const profile: ProfileItem = {
      id: 'opencode-client-auth',
      provider: 'opencode-client-auth',
      displayName: 'OpenCode (client-auth)',
      name: 'OpenCode (client-auth)',
      authType: 'oauth',
      protocol: 'anthropic',
      kind: 'builtin',
      builtin: true,
      mode: 'subscription',
      models: ['claude-sonnet-4'],
      hasApiKey: false,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
      oauthLikeClient: 'opencode',
    };

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.textContent).not.toContain('测试');
    expect(container.textContent).toContain('+ 添加');
    expect(container.textContent).toContain('OpenCode (client-auth)');
  });

  it('uses password input for API key edits and requires delete confirmation', async () => {
    const profile: ProfileItem = {
      id: 'codex-sponsor',
      provider: 'codex-sponsor',
      displayName: 'Codex Sponsor',
      name: 'Codex Sponsor',
      authType: 'api_key',
      protocol: 'openai',
      kind: 'api_key',
      builtin: false,
      mode: 'api_key',
      baseUrl: 'https://proxy.example',
      models: ['gpt-5.4'],
      hasApiKey: true,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    };
    const onDelete = vi.fn();
    mockConfirm.mockResolvedValue(false);

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={onDelete} />);
    });

    await act(async () => {
      queryButton(container, '编辑').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const apiKeyInput = container.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(apiKeyInput).not.toBeNull();
    expect(apiKeyInput?.getAttribute('autocomplete')).toBe('off');

    await act(async () => {
      queryButton(container, '取消').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      queryButton(container, '删除').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();

    mockConfirm.mockResolvedValue(true);
    await act(async () => {
      queryButton(container, '删除').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDelete).toHaveBeenCalledWith('codex-sponsor');
    mockConfirm.mockReset().mockResolvedValue(true);
  });
});
