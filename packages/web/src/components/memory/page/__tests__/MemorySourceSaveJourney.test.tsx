import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MemoryPage from '@/app/memory/page';
import { tasteEntry } from './recall-page-fixture';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), replace: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.fetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: mocks.replace }) }));
vi.mock('@/components/shell/shell-presentation', () => ({ useShellPresentation: () => 'v2' }));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => null }) }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
const oldRevision = `sha256:${'a'.repeat(64)}`;
const currentRevision = `sha256:${'c'.repeat(64)}`;
const families = [
  ['person', 'person_fixture', '人物详情', '判断内容'],
  ['taste', `taste-${'a'.repeat(24)}`, '品味详情', '品味概括'],
  ['event', 'evt_fixture', '事件详情', '事件内容'],
] as const;
let host: HTMLDivElement;
let root: Root;
let saved: boolean;
let latestText: string;
let failSave: boolean;
let withCorrection: boolean;
let unavailable: boolean;
let readsAfterSave: string[];
const reply = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });
function memory(family: string) {
  const revision = saved ? currentRevision : oldRevision;
  const text = saved ? latestText : '最初内容';
  if (family === 'person')
    return {
      personId: 'person_fixture',
      personRevision: revision,
      displayName: '虚构小林',
      aliases: [],
      status: 'active',
      createdAt: 1,
      updatedAt: 2,
      sourceCount: 1,
      claims: [
        {
          claimId: 'claim_fixture',
          revision,
          payload: { kind: 'reported_fact', assertedBy: 'owner', predicate: '负责的事', value: text },
          status: 'current',
          recordedAt: 2,
          sourceCount: 1,
        },
      ],
      relationships: [],
      interactions: [],
      truncation: { claims: false, relationships: false, interactions: false },
    };
  const correctionProposals =
    withCorrection && !saved
      ? [
          {
            proposalId: 'correction_fixture',
            status: 'pending',
            expectedRevision: oldRevision,
            reason: 'outdated',
            suggestedPatch: family === 'taste' ? { takeaway: '保存后的当前内容' } : { summary: '保存后的当前内容' },
            sourceCatId: 'sonnet',
            sourceThreadId: 'source',
            source: { threadId: 'source', messageId: 'original' },
            createdAt: 1,
          },
        ]
      : [];
  if (family === 'taste')
    return {
      correctionProposals,
      ...tasteEntry(`taste-${'a'.repeat(24)}`, 1),
      revision,
      status: 'active',
      takeaway: text,
    };
  return {
    correctionProposals,
    eventId: 'evt_fixture',
    ownerUserId: 'owner',
    revision,
    status: 'active',
    timestamp: 1,
    threadId: 'source',
    messageId: 'original',
    type: '第一性原理',
    trigger: 'human_brake',
    cat: 'sonnet',
    summary: text,
    cognitiveTransition: 'scope_correction',
    relatedHarness: null,
    confidence: 'high',
  };
}
function renderFromAddress() {
  const params = Object.fromEntries(new URLSearchParams(window.location.search));
  root.render(<MemoryPage searchParams={params} />);
}
async function open(family: string, id: string) {
  window.history.replaceState(
    null,
    '',
    `/memory?family=${family}&memoryId=${id}&revision=${encodeURIComponent(oldRevision)}&from=source`,
  );
  await act(async () => renderFromAddress());
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button?.click());
}
async function submit(textbox: string) {
  await click('编辑');
  const field = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${textbox}"]`);
  expect(field).not.toBeNull();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(field, '保存后的当前内容');
    field?.dispatchEvent(new Event('input', { bubbles: true }));
    field?.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () =>
    field?.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  saved = false;
  latestText = '保存后的当前内容';
  failSave = false;
  withCorrection = false;
  unavailable = false;
  readsAfterSave = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mocks.replace.mockImplementation((url: string) => {
    window.history.replaceState(null, '', url);
    renderFromAddress();
  });
  mocks.fetch.mockImplementation((path: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      if (failSave) return reply({ error: 'temporarily_unavailable' }, 503);
      saved = true;
      if (path.endsWith('/correction_fixture/approve'))
        return reply({ proposalId: 'correction_fixture', status: 'approved', appliedRevision: currentRevision });
      const command = JSON.parse(String(options.body));
      latestText = command.payload?.value ?? command.patch?.takeaway ?? command.patch?.summary;
      return reply({
        action: command.action,
        outcome: 'applied',
        memoryId: path.includes('/taste/') ? families[1][1] : 'evt_fixture',
        revision: currentRevision,
        status: 'active',
      });
    }
    if (saved) readsAfterSave.push(path);
    if (path.includes('/source?')) {
      const source = {
        kind: 'message',
        canOpen: true,
        label: '原对话',
        title: '原对话',
        threadId: 'source',
        messageId: 'original',
        occurredAt: 1,
        speaker: '你',
      };
      return reply({ status: 'ready', ...source, sources: [source] });
    }
    const family = path.startsWith('/api/memory/people/')
      ? 'person'
      : path.startsWith('/api/memory/taste/')
        ? 'taste'
        : path.startsWith('/api/memory/events/')
          ? 'event'
          : null;
    if (!family) return reply({});
    if (unavailable) return reply({}, 503);
    if (saved && path.includes(encodeURIComponent(oldRevision))) return reply({}, 409);
    return reply(memory(family));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.history.replaceState(null, '', '/memory');
  vi.clearAllMocks();
});
it.each(
  families,
)('a successful %s save stays on the current detail and survives a page refresh', async (family, id, label, textbox) => {
  await open(family, id);
  await submit(textbox);
  expect(host.querySelector(`aside[aria-label="${label}"]`)).not.toBeNull();
  expect(host.textContent).toContain('保存后的当前内容');
  expect(host.textContent).not.toContain('这条记忆在递来之后改过');
  expect(new URLSearchParams(location.search).has('revision')).toBe(false);
  expect(new URLSearchParams(location.search).get('from')).toBe('source');
  expect(readsAfterSave.some((path) => path.includes(encodeURIComponent(oldRevision)))).toBe(false);
  await act(async () => {
    root.unmount();
    root = createRoot(host);
    renderFromAddress();
  });
  expect(host.querySelector(`aside[aria-label="${label}"]`)).not.toBeNull();
  expect(host.textContent).toContain('保存后的当前内容');
  await open(family, id);
  expect(host.querySelector(`aside[aria-label="${label}"]`)).toBeNull();
  expect(host.textContent).toContain('这条记忆在递来之后改过');
});
it.each(
  families,
)('a stale %s link requires an explicit choice to open the current version', async (family, id, label) => {
  saved = true;
  await open(family, id);
  expect(host.textContent).toContain('这条记忆在递来之后改过');
  expect(host.textContent).not.toContain('重读记忆');
  const targetReads = readsAfterSave.filter((path) => path.includes(id));
  expect(targetReads.length).toBeGreaterThan(0);
  expect(targetReads.every((path) => path.includes(encodeURIComponent(oldRevision)))).toBe(true);
  await click('查看现在的版本');
  expect(new URLSearchParams(location.search).has('revision')).toBe(false);
  expect(host.querySelector(`aside[aria-label="${label}"]`)).not.toBeNull();
  expect(host.textContent).toContain('保存后的当前内容');
});
it('keeps a failed save on its delivered version instead of promoting unconfirmed data', async () => {
  failSave = true;
  await open('taste', families[1][1]);
  await submit('品味概括');
  expect(new URLSearchParams(location.search).get('revision')).toBe(oldRevision);
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(host.textContent).toContain('结果尚未确认');
});
it('retries a temporarily unavailable delivery without discarding its revision', async () => {
  unavailable = true;
  await open('event', 'evt_fixture');
  expect(host.textContent).not.toContain('查看现在的版本');
  unavailable = false;
  await click('重读记忆');
  expect(host.querySelector('aside[aria-label="事件详情"]')).not.toBeNull();
  expect(new URLSearchParams(location.search).get('revision')).toBe(oldRevision);
});

it.each([
  families[1],
  families[2],
])('an accepted %s correction also leaves the old delivery for the current detail', async (family, id, label) => {
  withCorrection = true;
  await open(family, id);
  await click('接受这条建议');
  expect(new URLSearchParams(location.search).has('revision')).toBe(false);
  expect(host.querySelector(`aside[aria-label="${label}"]`)).not.toBeNull();
  expect(host.textContent).toContain('保存后的当前内容');
  expect(readsAfterSave.some((path) => path.includes(encodeURIComponent(oldRevision)))).toBe(false);
});
