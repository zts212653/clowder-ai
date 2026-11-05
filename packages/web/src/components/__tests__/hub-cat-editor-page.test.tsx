import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { HubCatEditor } from '../HubCatEditor';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../useConfirm', () => ({ useConfirm: () => vi.fn(async () => true) }));
const cat: CatData = {
  id: 'test-member',
  name: '测试成员',
  displayName: '测试成员',
  nickname: '测试猫',
  avatar: '/avatars/codex.png',
  color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
  mentionPatterns: ['@test-member'],
  carrier: 'cli',
  clientId: 'anthropic',
  defaultModel: 'test-model',
  accountRef: 'claude',
  roleDescription: '隔离验收成员',
  personality: '',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('member page reuses the editor transaction', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (url === '/api/accounts')
        return json({
          providers: [
            {
              id: 'claude',
              name: 'Claude',
              displayName: 'Claude',
              clientId: 'anthropic',
              authType: 'oauth',
              kind: 'builtin',
              builtin: true,
              models: [],
            },
          ],
        });
      return json({});
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });
  const click = async (label: string) => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
    expect(button, `button ${label}`).toBeTruthy();
    await act(async () => button?.click());
  };
  async function renderPage(onClose = vi.fn(), onSaved = vi.fn()) {
    const props = { cat, existingCats: [cat], open: true, presentation: 'page' as const, onClose, onSaved };
    await act(async () => root.render(<HubCatEditor {...props} />));
    return { onClose, onSaved };
  }
  async function changeName(value: string) {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    expect(input).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  it('renders an inline detail page with navigation instead of a dialog', async () => {
    await renderPage();
    expect(container.querySelector('[data-testid="member-detail-page"]')).toBeTruthy();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('模型与接入');
    expect(container.textContent).not.toContain('无需手动保存');
  });
  it('discards edits without writing configuration', async () => {
    await renderPage();
    await changeName('修改后');
    expect(document.querySelector('.member-save-bar')?.textContent).toContain('1 处修改还没保存');
    await click('放弃修改');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe('测试成员');
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });
  it('keeps Save discoverable before editing, after restoring the original value and after discard', async () => {
    await renderPage();
    const saveButton = () =>
      Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '保存');
    const expectClean = () => {
      expect(saveButton(), 'the confirmation action must not disappear when there is no field difference').toBeTruthy();
      expect(saveButton()?.disabled).toBe(false);
      expect(document.querySelector('.member-save-bar')?.textContent).toContain('没有改动');
    };
    expectClean();
    await click('保存');
    await changeName('修改后');
    expect(saveButton()?.disabled).toBe(false);
    await changeName('测试成员');
    expectClean();
    await changeName('再次修改');
    await click('放弃修改');
    expectClean();
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });
  it('keeps the page and draft when the original API rejects a save', async () => {
    const callbacks = await renderPage();
    await changeName('修改后');
    vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
      init?.method ? json({ error: '没有权限' }, 403) : json({}),
    );
    await click('保存');
    expect(container.textContent).toContain('没有权限');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.value).toBe('修改后');
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(callbacks.onSaved).not.toHaveBeenCalled();
  });
  it('saves through the original endpoint and keeps the result visible', async () => {
    const callbacks = await renderPage();
    await changeName('保存后的名字');
    await click('保存');
    const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('/api/cats/test-member');
    expect(writes[0][1]?.method).toBe('PATCH');
    expect(JSON.parse(String(writes[0][1]?.body)).name).toBe('保存后的名字');
    expect(callbacks.onSaved).toHaveBeenCalledOnce();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain('已保存');
  });
  it('offers an honest template retry and still allows starting blank', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      url === '/api/cat-templates' ? json({ error: 'offline' }, 503) : json({ providers: [] }),
    );
    await act(async () => root.render(<HubCatEditor open presentation="page" onClose={vi.fn()} onSaved={vi.fn()} />));
    expect(container.textContent).toContain('模板读取失败');
    expect(container.textContent).toContain('从空白开始');
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      url === '/api/cat-templates'
        ? json({
            templates: [
              {
                id: 'birman',
                name: '梵花猫',
                nickname: '墨墨',
                color: { primary: '#6B5B7B', secondary: '#E8E0EE' },
                roleDescription: '伙伴',
                personality: '安静',
              },
            ],
          })
        : json({ providers: [] }),
    );
    await click('重试');
    expect(container.textContent).toContain('墨墨');
    expect(container.textContent).not.toContain('模板读取失败');
  });
  it('marks exact required fields without attempting a create', async () => {
    await act(async () => root.render(<HubCatEditor open presentation="page" onClose={vi.fn()} onSaved={vi.fn()} />));
    await click('添加');
    expect(container.querySelector('input[aria-label="Name"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('input[aria-label="Description"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });
  it('does not invent an unsaved Codex change when its runtime config read fails', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      url === '/api/config' ? json({}, 503) : json({ providers: [] }),
    );
    await act(async () =>
      root.render(
        <HubCatEditor
          open
          presentation="page"
          cat={{ ...cat, clientId: 'openai', accountRef: 'codex' }}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain('503');
    expect(document.querySelector('.member-save-bar')?.textContent).toContain('没有改动');
    expect(
      Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '保存')?.disabled,
    ).toBe(false);
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });
});
