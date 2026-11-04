import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';
import { useMemberEditor } from '../settings/members/useMemberEditor';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://member-recovery.test', apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('s=members&cat=recovery-member&lang=zh'),
}));
let editor: ReturnType<typeof useMemberEditor>;
let root: Root;
let container: HTMLDivElement;
let stored: CatData | undefined;
let readsFail = false;
let writes = 0;
const saved = vi.fn(async () => {});
const existing = {
  id: 'recovery-member',
  name: 'Member',
  displayName: 'Member',
  avatar: '',
  clientId: 'openai',
  carrier: 'app_server',
  configurationSource: 'native_tool',
  defaultModel: '',
  roleDescription: '团队伙伴',
  personality: '',
  mentionPatterns: ['@recovery-member'],
  color: { primary: '#123456', secondary: '#abcdef' },
  configurationRevision: 'before',
} as CatData;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function Harness({ member }: { member: CatData | null }) {
  editor = useMemberEditor(member, member ? [member] : [], saved);
  return (
    <button type="button" onClick={() => void editor.save()}>
      保存
    </button>
  );
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  saved.mockClear();
  stored = undefined;
  readsFail = false;
  writes = 0;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      writes++;
      const payload = JSON.parse(String(init.body));
      stored = { ...existing, ...payload, configurationRevision: 'after' };
      throw new TypeError('response lost after commit');
    }
    if (path === '/api/cats')
      return readsFail ? response({ error: 'offline' }, 503) : response({ cats: stored ? [stored] : [] });
    if (path === '/api/cats/native-runtimes') return response({ runtimes: [] });
    if (path === '/api/accounts') return response({ projectPath: '/isolated', providers: [] });
    if (path === '/api/session') return response({ userId: 'owner' });
    if (path === '/api/cat-templates') return response({ templates: [] });
    return response({ cats: [] });
  });
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});
async function render(member: CatData | null = null) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness member={member} />));
  if (!member) {
    await act(async () =>
      editor.switchRuntime({ id: 'codex', label: 'Codex', clientId: 'openai', installed: true, models: [] }),
    );
    await act(async () =>
      editor.patch({
        catId: 'recovery-member',
        name: 'Member',
        displayName: 'Member',
        mentionPatterns: '@recovery-member',
        roleDescription: '团队伙伴',
      }),
    );
  }
}

it('reads back a committed creation by stable catId after its response is lost', async () => {
  await render();
  await act(async () => editor.save());
  expect(editor.error).toBeNull();
  expect(editor.draft.baseline?.id).toBe('recovery-member');
  expect(saved).toHaveBeenCalledOnce();
  expect(writes).toBe(1);
});

it('keeps an unknown creation across remount and reconciles before another POST', async () => {
  await render();
  readsFail = true;
  await act(async () => editor.save());
  expect(editor.error).toBeTruthy();
  act(() => root.unmount());
  container.remove();
  await render();
  readsFail = false;
  expect(editor.draft.form).toEqual(editor.draft.pendingWrite?.form);
  await act(async () => editor.save());
  expect(writes).toBe(1);
  expect(editor.error).toBeNull();
  expect(editor.draft.baseline?.configurationRevision).toBe('after');
});

it('reads back a committed member PATCH without resending it', async () => {
  await render(existing);
  await act(async () => editor.patch({ personality: 'new personality' }));
  await act(async () => editor.save());
  expect(editor.error).toBeNull();
  expect(editor.draft.baseline?.personality).toBe('new personality');
  expect(writes).toBe(1);
});

it('recovers a restored legacy draft without a member version by explicitly reading and retaining edits', async () => {
  const previous = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'PATCH' && !JSON.parse(String(init.body)).expectedRevision)
      return response({ error: '缺少成员保存版本，请重新读取成员配置后再操作。' }, 428);
    return previous(path, init);
  });
  await render({ ...existing, configurationRevision: undefined });
  await act(async () => editor.patch({ personality: 'keep legacy edits' }));
  await act(async () => editor.save());
  expect(editor.error).toContain('缺少成员保存版本');
  act(() => root.unmount());
  container.remove();
  await render(existing);
  await act(async () => editor.save());
  expect(editor.conflicted).toBe(true);
  expect(editor.draft.form.personality).toBe('keep legacy edits');
  stored = existing;
  await act(async () => editor.refreshBaseline());
  expect(editor.draft.baseline?.configurationRevision).toBe('before');
  expect(editor.draft.form.personality).toBe('keep legacy edits');
  await act(async () => editor.save());
  expect(editor.error).toBeNull();
  expect(writes).toBe(1);
  expect(editor.draft.baseline?.personality).toBe('keep legacy edits');
});

it('preserves the draft when the pending catId belongs to a different configuration', async () => {
  await render();
  readsFail = true;
  await act(async () => editor.save());
  stored = { ...stored!, roleDescription: 'concurrent role' };
  readsFail = false;
  await act(async () => editor.save());
  expect(writes).toBe(1);
  expect(editor.error).toBeTruthy();
  expect(editor.draft.form.roleDescription).toBe('团队伙伴');
  expect(saved).not.toHaveBeenCalled();
});

it('rebases pending edits against the submitted form so reverting a value is preserved', async () => {
  await render(existing);
  readsFail = true;
  await act(async () => editor.patch({ personality: 'new personality' }));
  await act(async () => editor.save());
  await act(async () => editor.patch({ personality: '' }));
  readsFail = false;
  await act(async () => editor.save());
  expect(editor.draft.baseline?.personality).toBe('new personality');
  expect(editor.draft.form.personality).toBe('');
  expect(editor.draft.pendingWrite).toBeUndefined();
  expect(editor.dirtyCount).toBeGreaterThan(0);
});

it('the official page can reconcile a pending save even after the user reverts all dirty fields', async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(<MemberSettingsPage cat={existing} cats={[existing]} onSaved={saved} onBack={() => {}} />),
  );
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  const fill = async (value: string) => {
    const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="个性"]');
    expect(field).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value);
      field?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  await click('身份与职责');
  await fill('new personality');
  readsFail = true;
  await click('保存');
  await fill('');
  expect(container.textContent).toContain('上次保存结果待核对');
  readsFail = false;
  await click('核对上次保存');
  expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="个性"]')?.value).toBe('');
  expect(writes).toBe(1);
  await click('保存');
  expect(stored?.personality).toBe('');
  expect(saved).toHaveBeenCalledOnce();
});
