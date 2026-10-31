import type { CollectiveWorkGrantScope, CollectiveWorkPolicy } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { executeHostWorkPolicyCommand } from '../../../../../collective-client/src/host-work-policy-command.js';
import { CollectiveChannelListeningSettings } from '../CollectiveChannelListeningSettings';
import { CollectiveWorkPolicySettings } from '../CollectiveWorkPolicySettings';
import type { ParticipationView } from '../use-collective-participation';
import { useCollectiveWorkPolicy } from '../use-collective-work-policy';
import type { CollectiveWorkPolicyBridge } from '../use-collective-work-policy-bridge';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';

const policy = {
  revision: 2,
  ownerHumanId: 'human_12345678',
  decisionMode: 'manual',
  history: [],
  grants: [
    {
      grantRef: 'private-ref',
      grantRevision: 1,
      status: 'active',
      catIds: ['codex-sol'],
      channelIds: ['general'],
      requestingHumanIds: 'channel_members',
      requestKinds: ['guide'],
      expiresAt: null,
      decisionMode: 'automatic',
    },
  ],
};
const view = {
  cats: [{ id: 'codex-sol', displayName: '砚砚', configured: true, eligible: true, supported: true }],
  channelRoutes: { general: { participants: { 'codex-sol': {} } } },
} as unknown as ParticipationView;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
function Harness({
  bridge,
  surface = 'policy',
  participation = view,
  onSelectCats,
}: {
  bridge?: CollectiveWorkPolicyBridge;
  surface?: 'policy' | 'listening';
  participation?: ParticipationView;
  onSelectCats?: () => void;
}) {
  const state = useCollectiveWorkPolicy('con_12345678', bridge);
  return surface === 'policy' ? (
    <CollectiveWorkPolicySettings state={state} view={participation} channelId="general" enabled />
  ) : (
    <CollectiveChannelListeningSettings
      state={state}
      view={participation}
      channelId="general"
      enabled
      onSelectCats={onSelectCats}
    />
  );
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const local = {
  revision: 2,
  decisionMode: 'manual',
  pendingRevocations: [],
  grants: [{ grantRef: 'private-ref', grantRevision: 1, state: 'active', decisionMode: 'automatic' }],
};

async function policyProducedBy(permission: 'once' | 'class'): Promise<CollectiveWorkPolicy> {
  const proposal = {
    workId: 'work_12345678',
    revision: 1,
    lifecycle: 'proposed',
    sourceEventId: 'evt_12345678',
    sourceLocation: { channelId: 'general' },
    proposedRequestKind: 'guide',
    proposedBy: {
      kind: 'agent',
      humanId: 'human_12345678',
      connectionId: 'con_12345678',
      catId: 'codex-sol',
    },
  };
  let produced: CollectiveWorkPolicy | undefined;
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path.endsWith('read-owner'))
      return {
        policy: { revision: 1, decisionMode: 'manual', ownerHumanId: 'human_12345678', grants: [], history: [] },
      } as T;
    if (path.startsWith('/api/collaboration?')) return { works: [proposal] } as T;
    const grants = body.grants as CollectiveWorkGrantScope[];
    produced = {
      revision: 2,
      ownerHumanId: 'human_12345678',
      decisionMode: 'manual',
      history: [],
      grants: grants.map((grant) => ({ ...grant, grantRevision: 1, status: 'active' })),
    };
    return produced as T;
  }
  const values = new Map<string, string>();
  await executeHostWorkPolicyCommand({
    command: {
      type: 'collective:host-work-policy-command',
      bridgeId: 'bridge_12345678',
      contextId: 'context_12345678',
      contextRevision: 1,
      serviceInstanceId: 'svc_12345678',
      collectiveId: 'col_12345678',
      connectionId: 'con_12345678',
      humanId: 'human_12345678',
      commandId: `command_${permission}12345678`,
      action: { kind: 'allow_request', workId: proposal.workId, workRevision: 1, permission },
    },
    request,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
    },
  });
  if (!produced) throw new Error('work-policy producer did not register a policy');
  return produced;
}

it.each([
  ['once', '仅这一次：已允许砚砚处理 # general 里的这条「写作与整理」请求'],
  ['class', '# general 里任何人请砚砚做「写作与整理」，砚砚可以自己决定接'],
] as const)('presents a real %s producer grant with its actual scope', async (permission, expected) => {
  const produced = await policyProducedBy(permission);
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      String(url).endsWith('/listening')
        ? { attentionRevision: 0, channelListening: {} }
        : {
            policy: produced,
            localAdoption: {
              revision: produced.revision,
              decisionMode: produced.decisionMode,
              pendingRevocations: [],
              grants: produced.grants.map((grant) => ({
                grantRef: grant.grantRef,
                grantRevision: grant.grantRevision,
                state: 'active',
                decisionMode: grant.decisionMode ?? produced.decisionMode,
              })),
            },
          },
    ),
  );
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain(expected);
  if (permission === 'once') {
    expect(container.textContent).toContain('指定原请求已允许 · 仅这一次 · 已生效');
    expect(container.textContent).not.toContain('任何人请');
    expect(container.textContent).not.toContain('会先来问你');
    expect(container.textContent).not.toContain('不设到期');
  } else {
    expect(container.textContent).toContain('手动添加 · 不设到期 · 已生效');
    expect(container.textContent).not.toContain('仅这一次');
  }
});

it('shows registered pending adoption distinctly from effective class rules without exposing implementation fields', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      String(url).endsWith('/listening')
        ? { attentionRevision: 0, channelListening: {} }
        : { policy, localAdoption: null },
    ),
  );
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain('正在同步');
  expect(container.textContent).toContain('# general 里任何人请砚砚做「写作与整理」，砚砚可以自己决定接');
  expect(container.textContent).not.toContain('private-ref');
  expect(container.textContent).not.toMatch(/grant|scope|JSON|Thread/);
  expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('保存'))).toBe(false);
});
it('keeps the prior state while updating and never declares a failed local adoption effective', async () => {
  let resolve: (value: { policyRevision: number }) => void = () => {};
  const command = vi.fn(
    () =>
      new Promise<{ policyRevision: number }>((done) => {
        resolve = done;
      }),
  );
  const acknowledge = vi.fn();
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/adopt')) return response({ code: 'WORK_POLICY_REVISION_CONFLICT' }, 409);
    return response(
      String(url).endsWith('/listening')
        ? { attentionRevision: 0, channelListening: {} }
        : { policy, localAdoption: null },
    );
  });
  await act(async () =>
    root.render(<Harness bridge={{ command, acknowledge } as unknown as CollectiveWorkPolicyBridge} />),
  );
  const askFirst = container.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="接工作前先问我"]');
  await act(async () => askFirst?.click());
  expect(command).toHaveBeenCalledWith({ kind: 'set_mode', decisionMode: 'automatic' });
  expect(askFirst?.getAttribute('aria-checked')).toBe('true');
  expect(container.textContent).toContain('更新中');
  await act(async () => resolve({ policyRevision: 3 }));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('旧规则已失效');
  expect(acknowledge).not.toHaveBeenCalled();
  expect(container.textContent).toContain('正在同步');
});
it('changes only current channel listening and leaves work permissions alone', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      String(url).endsWith('/listening')
        ? { attentionRevision: 4, channelListening: {} }
        : { policy, localAdoption: local },
    ),
  );
  await act(async () => root.render(<Harness surface="listening" />));
  await act(async () => container.querySelectorAll<HTMLInputElement>('input[name="collective-listening"]')[1]?.click());
  const call = vi
    .mocked(apiFetch)
    .mock.calls.find(([url, init]) => String(url).endsWith('/listening') && init?.method === 'POST');
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    channelId: 'general',
    mode: 'all',
    expectedAttentionRevision: 4,
    dutyCatId: 'codex-sol',
  });
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(([url, init]) => String(url).includes('work-policy') && init?.method === 'POST'),
  ).toBe(false);
});

it('replaces a departed duty cat from the current channel participants', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      String(url).endsWith('/listening')
        ? { attentionRevision: 4, channelListening: { general: { mode: 'all', dutyCatId: 'old-cat' } } }
        : { policy, localAdoption: local },
    ),
  );
  await act(async () => root.render(<Harness surface="listening" />));
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="换一只留意消息的猫"]');
  expect(picker).not.toBeNull();
  await act(async () => {
    if (picker) {
      picker.value = 'codex-sol';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  const call = vi
    .mocked(apiFetch)
    .mock.calls.find(([url, init]) => String(url).endsWith('/listening') && init?.method === 'POST');
  expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ mode: 'all', dutyCatId: 'codex-sol' });
});

it('takes an empty channel to the participation roster instead of silently adding a cat', async () => {
  const onSelectCats = vi.fn();
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      String(url).endsWith('/listening')
        ? { attentionRevision: 0, channelListening: {} }
        : { policy, localAdoption: local },
    ),
  );
  await act(async () =>
    root.render(
      <Harness
        surface="listening"
        participation={{
          ...view,
          channelRoutes: { general: { channelId: 'general', threadId: 'thread_general', participants: {} } },
        }}
        onSelectCats={onSelectCats}
      />,
    ),
  );
  const choose = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '选择猫…');
  expect(choose).toBeDefined();
  await act(async () => choose?.click());
  expect(onSelectCats).toHaveBeenCalledOnce();
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it.each([
  'poll',
  'retry',
] as const)('clears a failed initial read after a successful %s without changing authority', async (via) => {
  let unavailable = true;
  let refresh = () => {};
  vi.spyOn(window, 'setInterval').mockImplementation((callback) => {
    refresh = callback as () => void;
    return 123 as unknown as ReturnType<typeof window.setInterval>;
  });
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    unavailable
      ? response({ code: 'CONNECTOR_OWNER_MISMATCH' }, 403)
      : response(
          String(url).endsWith('/listening')
            ? { attentionRevision: 0, channelListening: {} }
            : { policy: null, localAdoption: null },
        ),
  );
  await act(async () => root.render(<Harness />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('暂时无法读取授权设置');
  unavailable = false;
  await act(async () => {
    if (via === 'poll') refresh();
    else container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
  });
  expect(container.textContent).toContain('猫会在频道里回应别人；要接持续的工作，会先来问你。');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('keeps the read error until both policy and listening recover', async () => {
  let listeningUnavailable = true;
  let refresh = () => {};
  vi.spyOn(window, 'setInterval').mockImplementation((callback) => {
    refresh = callback as () => void;
    return 123 as unknown as ReturnType<typeof window.setInterval>;
  });
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/listening')
      ? listeningUnavailable
        ? response({}, 403)
        : response({ attentionRevision: 0, channelListening: {} })
      : response({ policy: null, localAdoption: null }),
  );
  await act(async () => root.render(<Harness surface="listening" />));
  await act(async () => refresh());
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  let listening = container.querySelectorAll<HTMLInputElement>('input[name="collective-listening"]');
  expect(listening[0]?.checked).toBe(false);
  expect(listening[1]?.checked).toBe(false);
  listeningUnavailable = false;
  await act(async () => refresh());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  listening = container.querySelectorAll<HTMLInputElement>('input[name="collective-listening"]');
  expect(listening[0]?.checked).toBe(true);
  expect(listening[1]?.checked).toBe(false);
});

it('recovers a snapshot failure after a confirmed setting change without claiming that the change failed', async () => {
  let unavailable = false;
  let refresh = () => {};
  vi.spyOn(window, 'setInterval').mockImplementation((callback) => {
    refresh = callback as () => void;
    return 123 as unknown as ReturnType<typeof window.setInterval>;
  });
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    return unavailable
      ? response({}, 503)
      : response(
          String(url).endsWith('/listening')
            ? { attentionRevision: 0, channelListening: {} }
            : { policy, localAdoption: local },
        );
  });
  await act(async () => root.render(<Harness surface="listening" />));
  // Directly exercise a successful mutation whose following reads are unavailable.
  const listening = container.querySelectorAll<HTMLInputElement>('input[name="collective-listening"]');
  vi.mocked(apiFetch).mockImplementationOnce(async () => {
    unavailable = true;
    return response({ attentionRevision: 1, channelListening: { general: { mode: 'all', dutyCatId: 'codex-sol' } } });
  });
  await act(async () => listening[1]?.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('读不到频道设置');
  unavailable = false;
  await act(async () => refresh());
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
