import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { HubCatEditor } from '../../HubCatEditor';
import { writeShellLanguage } from '../../shell/shell-language';
import { MemberCopyProvider } from '../editor-presentation';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../../useConfirm', () => ({ useConfirm: () => vi.fn(async () => true) }));
const cat: CatData = {
  id: 'redo-member',
  name: 'Test member',
  displayName: 'Test member',
  nickname: 'Tester',
  avatar: '/avatars/family/codex61-sol.png',
  color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
  mentionPatterns: ['@tester'],
  carrier: 'cli',
  clientId: 'anthropic',
  accountRef: 'claude',
  defaultModel: 'test-model',
  roleDescription: 'Review partner',
  personality: '',
};
const profile = {
  id: 'claude',
  name: 'Claude',
  clientId: 'anthropic',
  authType: 'oauth',
  kind: 'builtin',
  builtin: true,
  models: [],
};
let root: Root;
let container: HTMLDivElement;
let rejectSave: boolean;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  writeShellLanguage('zh');
  rejectSave = false;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (url === '/api/accounts') return json({ providers: [profile] });
    if (init?.method === 'PATCH')
      return rejectSave ? json({ error: '账号服务暂时连不上' }, 503) : json({ cat: { id: cat.id } });
    return json({});
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
async function render(presentation: 'page' | 'modal') {
  const callbacks = { onSaved: vi.fn(), onClose: vi.fn() };
  await act(async () =>
    root.render(
      <MemberCopyProvider>
        <HubCatEditor open cat={cat} presentation={presentation} {...callbacks} />
      </MemberCopyProvider>,
    ),
  );
  return callbacks;
}
function button(label: string) {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`missing button ${label}`);
  return found;
}
async function change(label: string, value: string) {
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!field) throw new Error(`missing input ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const writes = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);

it('keeps the Codex runtime baseline readable after the host refreshes the saved member', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    url === '/api/accounts'
      ? json({ providers: [{ ...profile, id: 'codex', clientId: 'openai' }] })
      : url === '/api/config'
        ? json({ config: { cli: { codexSandboxMode: 'workspace-write' }, codexExecution: {} } })
        : json({}),
  );
  const codex = { ...cat, clientId: 'openai', accountRef: 'codex' };
  const saved = async () =>
    root.render(
      <HubCatEditor
        open
        cat={{ ...codex, defaultModel: 'another-model' }}
        presentation="page"
        onSaved={saved}
        onClose={vi.fn()}
      />,
    );
  await act(async () =>
    root.render(<HubCatEditor open cat={codex} presentation="page" onSaved={saved} onClose={vi.fn()} />),
  );
  await change('Model', 'another-model');
  await act(async () => button('保存').click());
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="Codex Sandbox"]')?.disabled).toBe(false);
  expect(document.querySelector('[data-testid="member-save-feedback"]')?.textContent).toContain('已保存');
});

describe.each(['page', 'modal'] as const)('%s member save feedback', (presentation) => {
  it('rolls back an unbound legacy member without replaying its unchanged client identity', async () => {
    const legacyCat = { ...cat, accountRef: undefined };
    let storedNickname = cat.nickname;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (url === '/api/accounts') return json({ providers: [profile] });
      if (init?.method === 'PATCH') {
        const payload = JSON.parse(String(init.body));
        if (payload.clientId && !payload.accountRef) {
          return json({ error: 'client "anthropic" requires a provider binding' }, 400);
        }
        storedNickname = payload.nickname;
        return json({ cat: { id: cat.id } });
      }
      return json({});
    });
    await act(async () =>
      root.render(
        <HubCatEditor
          open
          cat={legacyCat}
          presentation={presentation}
          onClose={vi.fn()}
          onSaved={async () => {
            throw new Error('Readback failed');
          }}
        />,
      ),
    );
    await change('Nickname', 'Draft nickname');
    await act(async () => button('保存').click());
    expect(storedNickname).toBe('Tester');
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Nickname"]')?.value).toBe('Draft nickname');
    expect(document.querySelector('[data-testid="member-save-feedback"] [role="alert"]')?.textContent).toContain(
      'Readback failed',
    );
    const rollback = JSON.parse(String(writes().at(-1)?.[1]?.body));
    expect(rollback).not.toHaveProperty('clientId');
    expect(rollback).not.toHaveProperty('accountRef');
  });
  it('keeps an in-flight save from swallowing edits typed during the request', async () => {
    await render(presentation);
    await change('Model', 'another-model');
    let release: (() => void) | undefined;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(apiFetch).mockImplementation(async () => {
      await response;
      return json({ cat: { id: cat.id } });
    });
    await act(async () => button('保存').click());
    try {
      expect(document.querySelector('input[aria-label="Model"]')?.matches(':disabled')).toBe(true);
      expect(button('正在保存…').disabled).toBe(true);
    } finally {
      await act(async () => release?.());
    }
    expect(document.querySelector('input[aria-label="Model"]')?.matches(':disabled')).toBe(false);
  });
  it('keeps Save usable with no changes and explains the no-op without a write', async () => {
    await render(presentation);
    expect(button('保存').disabled).toBe(false);
    await act(async () => button('保存').click());
    expect(document.body.textContent).toContain('没有要保存的修改');
    expect(writes()).toHaveLength(0);
  });
  it('uses the same exact field changes for the summary and the changed field markers', async () => {
    await render(presentation);
    await change('Model', 'another-model');
    await change('Nickname', 'Another name');
    const footer = document.querySelector('[data-testid="member-save-feedback"]');
    expect(footer?.textContent).toContain('2 处修改还没保存');
    expect(footer?.querySelector('strong')?.textContent).toBe('2 处修改还没保存：');
    expect(footer?.querySelector('strong')?.textContent).not.toContain('模型');
    expect(footer?.textContent).toContain('模型');
    expect(footer?.textContent).toContain('昵称');
    expect(document.querySelector('input[aria-label="Model"]')?.closest('label')?.textContent).toContain('已改');
    expect(document.querySelector('input[aria-label="Nickname"]')?.closest('label')?.textContent).toContain('已改');
    await change('Model', 'test-model');
    expect(footer?.textContent).toContain('1 处修改还没保存');
    expect(document.querySelector('input[aria-label="Model"]')?.closest('label')?.textContent).not.toContain('已改');
    await act(async () => button('放弃修改').click());
    expect(footer?.textContent).toContain('没有改动');
    expect(writes()).toHaveLength(0);
  });
  it('keeps a rejected save beside Retry and retains the draft', async () => {
    const callbacks = await render(presentation);
    await change('Model', 'another-model');
    rejectSave = true;
    await act(async () => button('保存').click());
    const footer = document.querySelector('[data-testid="member-save-feedback"]');
    expect(footer?.querySelector('[role="alert"]')?.textContent).toContain('账号服务暂时连不上');
    expect(footer?.textContent).toContain('修改还在');
    expect(button('重新保存').disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Model"]')?.value).toBe('another-model');
    expect(callbacks.onClose).not.toHaveBeenCalled();
    rejectSave = false;
    await act(async () => button('重新保存').click());
    expect(callbacks.onSaved).toHaveBeenCalledOnce();
    expect(writes()).toHaveLength(2);
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(footer?.textContent).toContain('已保存');
    expect(footer?.textContent).toContain('下一次接活');
    await act(async () => button('保存').click());
    expect(writes()).toHaveLength(2);
    await change('Nickname', 'After saving');
    expect(footer?.textContent).toContain('1 处修改还没保存：昵称');
    await act(async () => button('放弃修改').click());
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Model"]')?.value).toBe('another-model');
  });
  it('rejects a cleared required name without a write and marks the field beside its draft', async () => {
    await render(presentation);
    await change('Name', '');
    await act(async () => button('保存').click());
    expect(writes()).toHaveLength(0);
    expect(document.querySelector('input[aria-label="Name"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('[data-testid="member-save-feedback"] [role="alert"]')?.textContent).toContain(
      '必填',
    );
  });
});
