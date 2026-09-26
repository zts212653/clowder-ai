import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { FirstRunQuestWizard } from '../FirstRunQuestWizard';
import { createJourneyState } from '../first-run-quest/onboarding-journey';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ refresh: vi.fn() }) }));

const clients = [
  {
    client: 'claude',
    provider: 'anthropic',
    label: 'Claude',
    cli: 'claude',
    installed: true,
    hasApiKey: false,
    authenticated: true,
    authStatus: 'ready' as const,
  },
  {
    client: 'codex',
    provider: 'openai',
    label: 'Codex',
    cli: 'codex',
    installed: true,
    hasApiKey: false,
    authenticated: true,
    authStatus: 'ready' as const,
  },
];
vi.mock('../first-run-quest/ClientStep', () => ({
  ClientStep: ({ onSelect }: { onSelect: (selected: typeof clients) => void }) => (
    <button onClick={() => onSelect(clients)}>选择两位伙伴</button>
  ),
}));
vi.mock('../first-run-quest/ConfigStep', () => ({
  ConfigStep: ({
    client,
    initialConfig,
    onComplete,
  }: {
    client: string;
    initialConfig?: { accountRef: string; model: string };
    onComplete: (config: { accountRef: string; model: string }) => void;
  }) => (
    <button
      data-testid="finish-config"
      onClick={() => onComplete(initialConfig ?? { accountRef: client, model: `${client}-model` })}
    >
      配置 {client}
    </button>
  ),
}));

let container: HTMLDivElement;
let root: Root;
const key = 'cat-cafe:onboarding-journey';

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (url === '/api/cats' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { catId: string; name: string };
      return Response.json({ cat: { id: body.catId, displayName: body.name } });
    }
    if (url === '/api/threads') return Response.json({ id: 'thread-recovered' });
    return Response.json({ clients, providers: [] });
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

async function mount() {
  await act(async () => {
    root.render(<FirstRunQuestWizard open onClose={() => undefined} onCreated={() => undefined} />);
  });
}
async function click(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent === text);
  expect(button, `missing button: ${text}`).toBeDefined();
  await act(async () => {
    button?.click();
  });
}
function seedSetup() {
  localStorage.setItem(
    key,
    JSON.stringify({
      ...createJourneyState(),
      stage: 'setup',
      demoCompletedAt: 1,
      setup: {
        template: {
          id: 'planner',
          name: '规划猫',
          nickname: '规划',
          avatar: 'cat',
          color: { primary: '#111', secondary: '#eee' },
          roleDescription: '规划',
          personality: '认真',
        },
        clients,
        configs: {},
        configIndex: 0,
      },
    }),
  );
}

it('restores the second configuration and keeps the first client configuration after remount', async () => {
  seedSetup();
  await mount();
  await click('选择两位伙伴');
  await click('配置 claude');
  expect(document.querySelector('[data-testid="finish-config"]')?.textContent).toBe('配置 codex');
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await mount();
  expect(document.querySelector('[data-testid="finish-config"]')?.textContent).toBe('配置 codex');
  await click('配置 codex');
  const payloads = vi
    .mocked(apiFetch)
    .mock.calls.filter(([url, init]) => url === '/api/cats' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as { accountRef: string; defaultModel: string });
  expect(payloads.map(({ accountRef, defaultModel }) => [accountRef, defaultModel])).toEqual([
    ['claude', 'claude-model'],
    ['codex', 'codex-model'],
  ]);
  expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toMatchObject({ stage: 'ready', threadId: 'thread-recovered' });
});

it('keeps completed configuration when going back and selecting the same clients again', async () => {
  seedSetup();
  await mount();
  await click('选择两位伙伴');
  await click('配置 claude');
  await click('返回');
  await click('选择两位伙伴');
  expect(document.querySelector('[data-testid="finish-config"]')?.textContent).toBe('配置 codex');
  await click('配置 codex');
  expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toMatchObject({ stage: 'ready' });
});

it('creates two members with distinct aliases accepted by the member API', async () => {
  seedSetup();
  const aliases = new Set<string>();
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (url === '/api/cats' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { catId: string; name: string; mentionPatterns: string[] };
      if (body.mentionPatterns.some((pattern) => aliases.has(pattern.toLowerCase()))) {
        return Response.json({ error: 'alias already used' }, { status: 400 });
      }
      body.mentionPatterns.forEach((pattern) => aliases.add(pattern.toLowerCase()));
      return Response.json({ cat: { id: body.catId, displayName: body.name } });
    }
    return Response.json({ id: 'thread-recovered' });
  });
  await mount();
  await click('选择两位伙伴');
  await click('配置 claude');
  await click('配置 codex');
  expect(document.body.textContent).not.toContain('创建 Codex 失败');
  expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toMatchObject({ stage: 'ready' });
});
