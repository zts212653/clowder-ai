import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';

let root: Root | undefined;
let container: HTMLDivElement;
function cleanup() {
  if (root) act(() => root?.unmount());
  root = undefined;
  container?.remove();
}
function control(label: string) {
  const found = Array.from(container.querySelectorAll('select')).find(
    (el) => el.getAttribute('aria-label') === label || el.closest('label')?.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`missing select: ${label}`);
  return found;
}
async function change(label: string, value: string) {
  await act(async () => {
    const el = control(label);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function click(label: string) {
  const el = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === label);
  if (!el) throw new Error(`missing button: ${label}`);
  await act(async () => el.click());
}

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://member-codex.test', apiFetch: vi.fn() }));
const query = new URLSearchParams('s=members&cat=codex');
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => query }));
const member: CatData = {
  id: 'codex',
  name: '伙伴',
  avatar: '/avatars/default.png',
  roleDescription: '',
  personality: '',
  displayName: '伙伴',
  clientId: 'openai',
  accountRef: 'codex-company',
  configurationSource: 'managed_account',
  defaultModel: 'gpt-5.4',
  color: { primary: '#123456', secondary: '#abcdef' },
  mentionPatterns: ['@partner'],
  cli: { command: 'codex', carrier: 'app_server', serviceTier: 'fast' },
};
let rejectApproval = false;
let rejectConfigRead = false;
const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  writes.length = 0;
  rejectApproval = false;
  rejectConfigRead = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      if (path === '/api/config' && rejectApproval && body.key === 'cli.codexApprovalPolicy')
        return response({ error: 'approval rejected' }, 503);
      return path === '/api/config'
        ? response({ ok: true })
        : response({ cat: { ...member, ...body, cli: { ...member.cli, ...body.cli } } });
    }
    if (path === '/api/config')
      return rejectConfigRead
        ? response({ error: 'cannot read config' }, 503)
        : response({
            config: {
              cli: { codexSandboxMode: 'workspace-write', codexApprovalPolicy: 'on-request' },
              codexExecution: { authMode: 'oauth' },
            },
          });
    if (path === '/api/accounts')
      return response({
        projectPath: '/preview',
        providers: [{ id: 'codex-company', clientId: 'openai', authType: 'oauth', displayName: '公司号' }],
      });
    if (path === '/api/session') return response({ userId: 'owner' });
    if (path === '/api/cat-templates') return response({ templates: [] });
    if (path === '/api/config/session-strategy') return response({ cats: [] });
    if (path === '/api/cats/native-runtimes') return response({ runtimes: [] });
    return response({});
  });
});
afterEach(cleanup);
async function openAdvanced() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(<MemberSettingsPage cat={member} cats={[member]} onSaved={async () => {}} onBack={() => {}} />),
  );
  await click('高级接入');
}
describe('member Codex advanced configuration', () => {
  it('keeps speed editable and writes only the changed member field', async () => {
    await openAdvanced();
    expect(control('速度档位').value).toBe('fast');
    await change('速度档位', 'standard');
    await click('保存');
    expect(container.textContent).toContain('已保存。');
    expect(writes).toEqual([{ path: '/api/cats/codex', body: { cli: { serviceTier: 'standard' } } }]);
  });
  it('preserves global draft across remount and retries only unapplied global fields', async () => {
    await openAdvanced();
    await change('Codex Sandbox', 'read-only');
    await change('Codex Approval', 'untrusted');
    cleanup();
    await openAdvanced();
    expect(control('Codex Sandbox').value).toBe('read-only');
    rejectApproval = true;
    await click('保存');
    expect(container.textContent).toContain('approval rejected');
    expect(control('Codex Approval').value).toBe('untrusted');
    rejectApproval = false;
    await click('保存');
    expect(container.textContent).not.toContain('approval rejected');
    expect(container.textContent).toContain('已保存。');
    const configWrites = writes.filter((entry) => entry.path === '/api/config');
    expect(configWrites.map((entry) => entry.body.key)).toEqual([
      'cli.codexSandboxMode',
      'cli.codexApprovalPolicy',
      'cli.codexApprovalPolicy',
    ]);
    expect(configWrites.some((entry) => entry.body.key === 'codex.execution.authMode')).toBe(false);
  });
  it('does not invent a writable global baseline when the read fails', async () => {
    rejectConfigRead = true;
    await openAdvanced();
    expect(container.textContent).toContain('cannot read config');
    expect(() => control('Codex Sandbox')).toThrow('missing select');
    await change('速度档位', 'standard');
    await click('保存');
    expect(container.textContent).toContain('已保存。');
    expect(writes.every((entry) => entry.path !== '/api/config')).toBe(true);
  });
});
