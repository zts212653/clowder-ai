import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import type { HubCatEditorFormState } from '../../hub-cat-editor.model';
import type { RuntimeChoice } from '../../settings/members/member-runtime-draft';
import { useNativeOnboarding } from '../useNativeOnboarding';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ refresh: vi.fn() }) }));
let root: Root;
let host: HTMLDivElement;
let setup: ReturnType<typeof useNativeOnboarding>;
let runtime: RuntimeChoice;
const onCreated = vi.fn();
const response = (data: unknown) => new Response(JSON.stringify(data));
function Harness() {
  setup = useNativeOnboarding(true, onCreated, 'members');
  return null;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  runtime = {
    id: 'codex',
    label: 'Codex',
    clientId: 'openai',
    installed: true,
    models: [],
    readiness: { status: 'login_required', checkedAt: 1 },
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/session') return response({ userId: 'scope-owner' });
    if (String(path).split('?')[0] === '/api/cats/native-runtimes') return response({ runtimes: [runtime] });
    if (path === '/api/cat-templates') return response({ templates: [] });
    if (path === '/api/config/onboarding/entry') return response({ status: 'pending' });
    if (path === '/api/cats') {
      if (!init?.method) return response({ cats: [] });
      const payload = JSON.parse(String(init.body));
      return response({
        cat: { id: payload.catId, displayName: payload.displayName, mentionPatterns: payload.mentionPatterns },
      });
    }
    throw new Error(`Unexpected path: ${path}`);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const identities = [
  ['explicit account', { accountRef: 'company-account' }],
  ['custom configuration', { cliConfigArgs: ['--settings', '/fixture/settings.json'] }],
  ['custom startup', { commandArgs: '--custom-startup' }],
  ['ACP identity', { clientId: 'acp', carrier: 'acp', acpCommand: 'node', acpStartupArgs: 'bridge.js' }],
] satisfies [string, Partial<HubCatEditorFormState>][];

it.each(identities)('submits %s independently of default login evidence', async (_, change) => {
  await act(async () => root.render(<Harness />));
  expect(setup.draft?.partners[0].selected).toBe(false);
  const partner = setup.draft!.partners[0];
  await act(async () => setup.patchPartner(partner.id, { selected: true, form: { ...partner.form, ...change } }));
  await act(async () => setup.start());
  const writes = vi
    .mocked(apiFetch)
    .mock.calls.filter(([path, init]) => path === '/api/cats' && init?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(onCreated).toHaveBeenCalledOnce();
});

it.each(
  identities.slice(0, 3),
)('preserves selected %s through rediscovery with a failed default login', async (_, change) => {
  await act(async () => root.render(<Harness />));
  const partner = setup.draft!.partners[0];
  await act(async () => setup.patchPartner(partner.id, { selected: true, form: { ...partner.form, ...change } }));
  await act(async () => setup.reload());
  expect(setup.draft?.partners[0].selected).toBe(true);
  expect(setup.draft?.partners[0].form).toMatchObject(change);
  await act(async () => setup.start());
  expect(onCreated).toHaveBeenCalledOnce();
});

it.each([
  'login_required',
  'unknown',
] as const)('does not submit a stale selected default connection with %s readiness', async (status) => {
  runtime.readiness = { status, checkedAt: 1 };
  await act(async () => root.render(<Harness />));
  await act(async () => setup.patchPartner('codex', { selected: true }));
  await act(async () => setup.start());
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('does not submit an unavailable tool even with a separate account', async () => {
  runtime.installed = false;
  await act(async () => root.render(<Harness />));
  const partner = setup.draft!.partners[0];
  await act(async () =>
    setup.patchPartner(partner.id, { selected: true, form: { ...partner.form, accountRef: 'private' } }),
  );
  await act(async () => setup.start());
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
