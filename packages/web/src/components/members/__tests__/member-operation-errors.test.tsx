import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { HubCatEditor } from '../../HubCatEditor';
import { writeShellLanguage } from '../../shell/shell-language';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../../useConfirm', () => ({ useConfirm: () => vi.fn(async () => true) }));
const cat: CatData = {
  id: 'operation-member',
  name: 'Member',
  displayName: 'Member',
  nickname: 'Original',
  avatar: '/avatars/family/codex61-sol.png',
  color: { primary: '#123456', secondary: '#abcdef' },
  mentionPatterns: ['@operation-member'],
  carrier: 'cli',
  clientId: 'anthropic',
  accountRef: 'claude',
  defaultModel: 'test-model',
  roleDescription: 'Reviewer',
  personality: '',
};
let root: Root;
let container: HTMLDivElement;
let failures: Set<string>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  writeShellLanguage('zh');
  failures = new Set();
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (failures.has(url)) return json({ error: 'Operation unavailable' }, 503);
    if (url === '/api/accounts')
      return json({
        providers: [{ id: 'claude', clientId: 'anthropic', authType: 'oauth', kind: 'builtin', models: [] }],
      });
    if (url.startsWith('/api/uploads/')) return json({ url: '/uploads/retried-file' });
    return json({});
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function button(label: string) {
  const found = [...document.querySelectorAll('button')].find((value) => value.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
const footer = () => document.querySelector('[data-testid="member-save-feedback"]');
const issue = (kind: string) => document.querySelector(`[data-testid="member-operation-${kind}"]`);
const calls = (url: string) => vi.mocked(apiFetch).mock.calls.filter(([path]) => path === url);
function fileContents(file: File) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function editNickname() {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Nickname"]');
  if (!input) throw new Error('Missing nickname');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Keep this draft');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
describe.each(['page', 'modal'] as const)('%s contextual operation errors', (presentation) => {
  async function render(member = cat) {
    await act(async () =>
      root.render(<HubCatEditor open cat={member} presentation={presentation} onSaved={vi.fn()} onClose={vi.fn()} />),
    );
  }
  it('retries failed account loading without calling it a failed save or dropping the draft', async () => {
    failures.add('/api/accounts');
    await render();
    expect(footer()?.textContent).not.toContain('没保存上');
    expect(issue('accounts')?.getAttribute('role')).toBe('alert');
    await act(async () => button('保存').click());
    expect(issue('accounts')).not.toBeNull();
    await render({ ...cat });
    expect(issue('accounts')).not.toBeNull();
    expect(calls('/api/accounts')).toHaveLength(1);
    await editNickname();
    failures.delete('/api/accounts');
    await act(async () => button('重新加载账号').click());
    expect(calls('/api/accounts')).toHaveLength(2);
    expect(issue('accounts')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Nickname"]')?.value).toBe('Keep this draft');
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });
  it.each([
    ['avatar', '/api/uploads/avatar', 'image/png', '重新上传头像'],
    ['audio', '/api/uploads/ref-audio', 'audio/wav', '重新上传参考音频'],
  ])('retries the same %s upload at its field without substituting member save', async (kind, url, mime, label) => {
    await render();
    await editNickname();
    failures.add(url);
    const input = document.querySelector<HTMLInputElement>(`input[type="file"][accept^="${mime}"]`);
    if (!input) throw new Error(`Missing ${kind} input`);
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['test'], 'sample', { type: mime })],
    });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(footer()?.textContent).not.toContain('没保存上');
    expect(issue(kind)?.textContent).toContain('Operation unavailable');
    failures.delete(url);
    await act(async () => button(label).click());
    expect(calls(url)).toHaveLength(2);
    const originalFile = (calls(url)[0][1]?.body as FormData).get('file') as File;
    const retriedFile = (calls(url)[1][1]?.body as FormData).get('file') as File;
    expect(retriedFile).toMatchObject({ name: originalFile.name, size: originalFile.size, type: originalFile.type });
    expect(await fileContents(retriedFile)).toBe(await fileContents(originalFile));
    expect(issue(kind)).toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Nickname"]')?.value).toBe('Keep this draft');
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });
  it('retries cloud identity recovery explicitly without describing a member save failure', async () => {
    const cloud: CatData = {
      ...cat,
      id: 'gpt-pro',
      clientId: 'openai',
      defaultModel: 'gpt-pro',
      identityProtection: {
        kind: 'builtin-cloud',
        state: 'drifted',
        lockedFields: ['clientId', 'defaultModel'],
        driftedFields: ['defaultModel'],
      },
    };
    failures.add('/api/cats/gpt-pro');
    await render(cloud);
    await act(async () => button('恢复云端身份配置').click());
    expect(footer()?.textContent).not.toContain('没保存上');
    expect(issue('restore')?.textContent).toContain('Operation unavailable');
    failures.delete('/api/cats/gpt-pro');
    await act(async () => button('重新恢复身份').click());
    expect(calls('/api/cats/gpt-pro')).toHaveLength(2);
    for (const [, init] of calls('/api/cats/gpt-pro'))
      expect(JSON.parse(String(init?.body))).toEqual({ restoreBuiltinCloudIdentity: true });
    expect(issue('restore')).toBeNull();
  });
});
