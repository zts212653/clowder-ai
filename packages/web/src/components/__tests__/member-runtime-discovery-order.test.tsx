import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useMemberModelCatalogs } from '@/lib/member-model-display';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../hub-cat-editor.model';
import { MemberRuntimeFields } from '../settings/members/MemberRuntimeFields';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each([
  'failed',
  'cancelled',
  'success',
] as const)('orders successful discoveries across panels when the newer request is %s', async (newer) => {
  useMemberModelCatalogs.setState(useMemberModelCatalogs.getInitialState());
  const acp = {
    command: 'node',
    startupArgs: ['/install/dsh/lib/bin.js', '--profile', 'acp'],
    transport: 'stdio' as const,
  };
  const runtime = {
    id: 'acp:verified',
    label: 'DSH',
    clientId: 'acp',
    installed: true,
    dshSetupSupported: true,
    models: [],
    acp,
  };
  let finish: (response: Response) => void = () => {};
  const earlier = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  let reads = 0;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url.startsWith('/api/cats/native-runtimes')) {
      if (++reads === 1) return earlier;
      if (newer === 'cancelled') return new Promise<Response>(() => {});
      return newer === 'failed' ? Response.json({}, { status: 503 }) : Response.json({ runtimes: [] });
    }
    if (url === '/api/agent-providers') return Response.json({ libraries: [] });
    return Response.json({ status: 'live', models: [], effortOptions: [] });
  });
  const host = document.createElement('div');
  const otherHost = document.createElement('div');
  const root = createRoot(host);
  const other = createRoot(otherHost);
  let otherMounted = true;
  const panel = (id: string) => (
    <MemberRuntimeFields
      form={{
        ...initialState(),
        catId: id,
        clientId: 'acp',
        carrier: 'acp',
        configurationSource: 'native_tool',
        accountRef: '',
        acpCommand: 'node',
        acpStartupArgs: acp.startupArgs.join(' '),
      }}
      accounts={[]}
      patch={vi.fn()}
      t={(zh) => zh}
      accountHref="/settings?s=accounts"
      editing
    />
  );
  try {
    await act(async () => root.render(panel('first')));
    await act(async () => other.render(panel('second')));
    expect(reads).toBe(2);
    if (newer === 'cancelled') {
      await act(async () => other.unmount());
      otherMounted = false;
    }
    await act(async () => finish(Response.json({ runtimes: [runtime] })));
    if (newer === 'success') expect(host.textContent).not.toContain('复用 DSH Desktop');
    else expect(host.textContent).toContain('复用 DSH Desktop');
    expect(vi.mocked(apiFetch).mock.calls.some(([, request]) => request?.method === 'PATCH')).toBe(false);
  } finally {
    await act(async () => {
      root.unmount();
      if (otherMounted) other.unmount();
    });
    useMemberModelCatalogs.setState(useMemberModelCatalogs.getInitialState());
    vi.resetAllMocks();
  }
});
