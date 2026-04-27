import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubAccountItem } from '@/components/HubAccountItem';
import type { ProfileItem } from '@/components/hub-accounts.types';

const mockConfirm = vi.fn().mockResolvedValue(true);
vi.mock('@/components/useConfirm', () => ({
  useConfirm: () => mockConfirm,
}));

function profileItem(
  input: Omit<ProfileItem, 'kind' | 'builtin'> & Partial<Pick<ProfileItem, 'kind' | 'builtin'>>,
): ProfileItem {
  const builtin = input.builtin ?? input.authType === 'oauth';
  return { ...input, builtin, kind: input.kind ?? (builtin ? 'builtin' : 'api_key') };
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

  it('clicking the card triggers onEdit for API key accounts', async () => {
    const profile = profileItem({
      id: 'claude-api',
      provider: 'claude-api',
      displayName: 'Claude API',
      name: 'Claude API',
      authType: 'api_key',
      mode: 'api_key',
      baseUrl: 'https://api.anthropic.com',
      models: ['claude-opus-4-1'],
      hasApiKey: true,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    });
    const onEdit = vi.fn();

    await act(async () => {
      root.render(
        <HubAccountItem
          profile={profile}
          busy={false}
          onSave={vi.fn(async () => {})}
          onDelete={() => {}}
          onEdit={onEdit}
        />,
      );
    });

    expect(container.textContent).not.toContain('编辑');
    expect(container.querySelector('button[aria-label="删除账号"]')).toBeTruthy();

    // Click the card itself to trigger edit
    const card = container.querySelector('[class*="rounded-"]') as HTMLElement;
    await act(async () => {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onEdit).toHaveBeenCalledWith(profile);
  });

  it('keeps the + 添加 model entry visible for built-in cards without binding-scope controls', async () => {
    const profile = profileItem({
      id: 'codex-oauth',
      provider: 'codex-oauth',
      displayName: 'Codex (OAuth)',
      name: 'Codex (OAuth)',
      authType: 'oauth',

      mode: 'subscription',
      models: ['gpt-5.4'],
      hasApiKey: false,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    });

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.textContent).toContain('+ 添加');
    expect(container.textContent).not.toContain('编辑');
    expect(container.textContent).not.toContain('绑定范围');
    expect(container.textContent).not.toContain('设为 Codex 默认');
  });

  it('hides unsupported 测试 actions for non-api-key profiles', async () => {
    const profile = profileItem({
      id: 'opencode-client-auth',
      provider: 'opencode-client-auth',
      displayName: 'OpenCode (client-auth)',
      name: 'OpenCode (client-auth)',
      authType: 'oauth',

      mode: 'subscription',
      models: ['claude-sonnet-4'],
      hasApiKey: false,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
      oauthLikeClient: 'opencode',
    });

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.textContent).not.toContain('测试');
    expect(container.textContent).toContain('+ 添加');
    expect(container.textContent).toContain('OpenCode (client-auth)');
  });

  it('requires delete confirmation and respects denial', async () => {
    const profile = profileItem({
      id: 'codex-sponsor',
      provider: 'codex-sponsor',
      displayName: 'Codex Sponsor',
      name: 'Codex Sponsor',
      authType: 'api_key',
      mode: 'api_key',
      baseUrl: 'https://proxy.example',
      models: ['gpt-5.4'],
      hasApiKey: true,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    });
    const onDelete = vi.fn();
    mockConfirm.mockResolvedValue(false);

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={onDelete} />);
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="删除账号"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();

    mockConfirm.mockResolvedValue(true);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="删除账号"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDelete).toHaveBeenCalledWith('codex-sponsor');
    mockConfirm.mockReset().mockResolvedValue(true);
  });
});
