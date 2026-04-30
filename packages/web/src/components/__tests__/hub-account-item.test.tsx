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

  it('non-builtin card shows only trash icon, no pencil', async () => {
    const profile = profileItem({
      id: 'claude-api',
      provider: 'claude-api',
      displayName: 'Claude API',
      name: 'Claude API',
      authType: 'api_key',
      kind: 'api_key',
      builtin: false,
      mode: 'api_key',
      baseUrl: 'https://api.anthropic.com',
      models: ['claude-opus-4-1'],
      hasApiKey: true,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    });

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.querySelector('button[title="删除"]')).toBeTruthy();
    expect(container.querySelector('button[title="编辑"]')).toBeNull();
  });

  it('builtin card shows no action buttons', async () => {
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

    expect(container.textContent).toContain('OAuth');
    expect(container.querySelector('button[title="删除"]')).toBeNull();
    expect(container.querySelector('button[title="编辑"]')).toBeNull();
  });

  it('shows host + auth type summary for non-builtin', async () => {
    const profile = profileItem({
      id: 'codex-sponsor',
      provider: 'codex-sponsor',
      displayName: 'Codex Sponsor',
      name: 'Codex Sponsor',
      authType: 'api_key',
      kind: 'api_key',
      builtin: false,
      mode: 'api_key',
      baseUrl: 'https://proxy.example',
      models: ['gpt-5.4'],
      hasApiKey: true,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    });

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.textContent).toContain('Codex Sponsor');
    expect(container.textContent).toContain('API Key');
  });

  it('shows host placeholder when no baseUrl', async () => {
    const profile: ProfileItem = {
      id: 'no-url',
      provider: 'custom',
      displayName: 'No URL',
      name: 'No URL',
      authType: 'api_key',
      kind: 'api_key',
      builtin: false,
      mode: 'api_key',
      models: [],
      hasApiKey: false,
      createdAt: '2026-03-18T00:00:00.000Z',
      updatedAt: '2026-03-18T00:00:00.000Z',
    };

    await act(async () => {
      root.render(<HubAccountItem profile={profile} busy={false} onSave={vi.fn(async () => {})} onDelete={() => {}} />);
    });

    expect(container.textContent).toContain('(未设置)');
    expect(container.textContent).toContain('API Key');
  });

  it('trash button triggers confirm before calling onDelete', async () => {
    const profile = profileItem({
      id: 'deletable',
      provider: 'custom',
      displayName: 'Deletable Account',
      name: 'Deletable',
      authType: 'api_key',
      kind: 'api_key',
      builtin: false,
      mode: 'api_key',
      baseUrl: 'https://custom.api',
      models: [],
      hasApiKey: true,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
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

  it('clicking non-builtin card body triggers onEdit (no pencil icon)', async () => {
    const profile = profileItem({
      id: 'editable-api',
      provider: 'custom',
      displayName: 'Editable Account',
      name: 'Editable',
      authType: 'api_key',
      kind: 'api_key',
      builtin: false,
      mode: 'api_key',
      baseUrl: 'https://custom.api',
      models: [],
      hasApiKey: true,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
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

    expect(container.querySelector('button[title="编辑"]')).toBeNull();

    const cardBody = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Editable Account'),
    );
    expect(cardBody).toBeTruthy();

    await act(async () => {
      cardBody!.click();
    });

    expect(onEdit).toHaveBeenCalledWith('editable-api');
  });

  it('builtin card body is not clickable', async () => {
    const profile = profileItem({
      id: 'builtin-oauth',
      provider: 'builtin-oauth',
      displayName: 'Built-in OAuth',
      name: 'Built-in OAuth',
      authType: 'oauth',
      mode: 'subscription',
      models: [],
      hasApiKey: false,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
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

    const cardBody = container.querySelector('button[disabled]');
    expect(cardBody).toBeTruthy();

    await act(async () => {
      cardBody!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onEdit).not.toHaveBeenCalled();
  });

  it('trash button does NOT call onDelete when confirm is cancelled', async () => {
    mockConfirm.mockResolvedValueOnce(false);

    const profile = profileItem({
      id: 'keep-me',
      provider: 'custom',
      displayName: 'Keep Me',
      name: 'Keep Me',
      authType: 'api_key',
      kind: 'api_key',
      builtin: false,
      mode: 'api_key',
      models: [],
      hasApiKey: true,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
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
