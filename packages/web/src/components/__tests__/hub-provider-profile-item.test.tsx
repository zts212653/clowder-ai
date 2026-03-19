import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubProviderProfileItem, type ProfileEditPayload } from '@/components/HubProviderProfileItem';
import type { ProfileItem } from '@/components/hub-provider-profiles.types';

function queryButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text));
  if (!button) {
    throw new Error(`Missing button: ${text}`);
  }
  return button as HTMLButtonElement;
}

describe('HubProviderProfileItem', () => {
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
      builtin: false,
      mode: 'api_key',
      baseUrl: 'https://api.anthropic.com',
      models: ['claude-opus-4-1'],
      modelOverride: 'claude-opus-4-1',
      hasApiKey: true,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    };
    const onSave = vi.fn(async () => {});

    await act(async () => {
      root.render(
        <HubProviderProfileItem
          profile={profile}
          busy={false}
          onSave={onSave}
          onTest={() => {}}
          onDelete={() => {}}
        />,
      );
    });

    await act(async () => {
      queryButton(container, '编辑').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      queryButton(container, '保存').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]?.[1] as ProfileEditPayload;
    expect(payload).toMatchObject({
      displayName: 'Claude API',
      baseUrl: 'https://api.anthropic.com',
      models: ['claude-opus-4-1'],
    });
    expect(Object.prototype.hasOwnProperty.call(payload, 'modelOverride')).toBe(false);
  });

  it('keeps the + 添加 model entry visible for built-in cards', async () => {
    const profile: ProfileItem = {
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
    };

    await act(async () => {
      root.render(<HubProviderProfileItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onTest={() => {}} onDelete={() => {}} />);
    });

    expect(container.textContent).toContain('+ 添加');
    expect(container.textContent).not.toContain('编辑');
  });

  it('hides unsupported 测试 actions for non-api-key profiles', async () => {
    const profile: ProfileItem = {
      id: 'opencode-client-auth',
      provider: 'opencode-client-auth',
      displayName: 'OpenCode (client-auth)',
      name: 'OpenCode (client-auth)',
      authType: 'oauth',
      protocol: 'anthropic',
      builtin: true,
      mode: 'subscription',
      models: ['claude-sonnet-4'],
      hasApiKey: false,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
      oauthLikeClient: 'opencode',
    };

    await act(async () => {
      root.render(<HubProviderProfileItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onTest={() => {}} onDelete={() => {}} />);
    });

    expect(container.textContent).not.toContain('测试');
    expect(container.textContent).toContain('+ 添加');
  });
});
