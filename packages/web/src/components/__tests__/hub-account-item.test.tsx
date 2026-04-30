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
  input: Partial<ProfileItem> & Pick<ProfileItem, 'id' | 'displayName' | 'name' | 'authType'>,
): ProfileItem {
  return {
    provider: input.id,
    kind: input.authType === 'oauth' ? 'builtin' : 'api_key',
    builtin: input.authType === 'oauth',
    mode: input.authType === 'oauth' ? 'subscription' : 'api_key',
    models: [],
    hasApiKey: input.authType === 'api_key',
    createdAt: '2026-03-18T00:00:00.000Z',
    updatedAt: '2026-03-18T00:00:00.000Z',
    ...input,
  };
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

  it('API key card shows trash button', async () => {
    const profile = profileItem({
      id: 'claude-api',
      displayName: 'Claude API',
      name: 'Claude API',
      authType: 'api_key',
      baseUrl: 'https://api.anthropic.com',
      models: ['claude-opus-4-1'],
    });

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.querySelector('button[title="删除"]')).toBeTruthy();
  });

  it('OAuth card also shows trash button', async () => {
    const profile = profileItem({
      id: 'codex-oauth',
      displayName: 'Codex (OAuth)',
      name: 'Codex (OAuth)',
      authType: 'oauth',
      models: ['gpt-5.4'],
    });

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.textContent).toContain('OAuth');
    expect(container.querySelector('button[title="删除"]')).toBeTruthy();
  });

  it('shows host + auth type summary for API key accounts', async () => {
    const profile = profileItem({
      id: 'codex-sponsor',
      displayName: 'Codex Sponsor',
      name: 'Codex Sponsor',
      authType: 'api_key',
      baseUrl: 'https://proxy.example',
      models: ['gpt-5.4'],
    });

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.textContent).toContain('Codex Sponsor');
    expect(container.textContent).toContain('proxy.example');
    expect(container.textContent).toContain('API Key');
  });

  it('shows auth type only when no baseUrl', async () => {
    const profile = profileItem({
      id: 'no-url',
      displayName: 'No URL',
      name: 'No URL',
      authType: 'api_key',
    });

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.textContent).toContain('API Key');
  });

  it('trash button triggers confirm before calling onDelete', async () => {
    const profile = profileItem({
      id: 'deletable',
      displayName: 'Deletable Account',
      name: 'Deletable',
      authType: 'api_key',
      baseUrl: 'https://custom.api',
    });
    const onDelete = vi.fn();

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={onDelete} />);
    });

    const trashBtn = container.querySelector('button[title="删除"]') as HTMLButtonElement;
    expect(trashBtn).toBeTruthy();

    await act(async () => {
      trashBtn.click();
    });

    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ variant: 'danger', title: '删除账号' }));
    expect(onDelete).toHaveBeenCalledWith('deletable');
  });

  it('clicking card body triggers onEdit', async () => {
    const profile = profileItem({
      id: 'editable-api',
      displayName: 'Editable Account',
      name: 'Editable',
      authType: 'api_key',
      baseUrl: 'https://custom.api',
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

    const card = container.querySelector('[class*="cursor-pointer"]') as HTMLElement;
    expect(card).toBeTruthy();

    await act(async () => {
      card.click();
    });

    expect(onEdit).toHaveBeenCalledWith('editable-api');
  });

  it('OAuth card body is also clickable for editing', async () => {
    const profile = profileItem({
      id: 'oauth-edit',
      displayName: 'OAuth Account',
      name: 'OAuth Account',
      authType: 'oauth',
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

    const card = container.querySelector('[class*="cursor-pointer"]') as HTMLElement;
    expect(card).toBeTruthy();

    await act(async () => {
      card.click();
    });

    expect(onEdit).toHaveBeenCalledWith('oauth-edit');
  });

  it('trash button does NOT call onDelete when confirm is cancelled', async () => {
    mockConfirm.mockResolvedValueOnce(false);

    const profile = profileItem({
      id: 'keep-me',
      displayName: 'Keep Me',
      name: 'Keep Me',
      authType: 'api_key',
    });
    const onDelete = vi.fn();

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={onDelete} />);
    });

    const trashBtn = container.querySelector('button[title="删除"]') as HTMLButtonElement;
    await act(async () => {
      trashBtn.click();
    });

    expect(mockConfirm).toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
