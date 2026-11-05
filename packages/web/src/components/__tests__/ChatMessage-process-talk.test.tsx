import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { resetProcessTalkPreferenceForTest } from '@/hooks/useProcessTalkPreference';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { ThemeSettingsPanel } from '../settings/ThemeSettingsPanel';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

vi.mock('@/utils/api-client', async (original) => ({
  ...(await original<typeof import('@/utils/api-client')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/stores/themeStore', () => ({
  useThemeStore: () => ({
    themes: [{ id: 'light', name: 'Light', builtIn: true }],
    activeId: 'light',
    setActive: vi.fn(),
    deleteCustom: vi.fn(),
    createCustom: vi.fn(),
  }),
}));

const early = '不用你做什么，已经交给原来的猫修。';
const answer = '两件事现在都接上了。';
function reply(): ChatMessage {
  const content = `${early}\n\n${answer}`;
  return streamReply({
    content,
    toolEvents: [
      { id: 'read', executionRef: 'turn-1', type: 'tool_use', label: 'Read original source', timestamp: 1 },
      { id: 'result', executionRef: 'turn-1', type: 'tool_result', label: 'Read result', timestamp: 2 },
    ],
    extra: {
      stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' },
      outputLayout: {
        v: 1,
        status: 'available',
        basis: 'successful_turn_last_tool',
        owner: { threadId: 'thread-1', catId: 'opus', turnInvocationId: 'turn-1' },
        contentRevision: { length: content.length, sha256: createHash('sha256').update(content).digest('hex') },
        runs: [
          { id: 'early', channel: 'commentary', start: 0, end: early.length, gluePrefixLength: 0 },
          { id: 'answer', channel: 'final', start: early.length, end: content.length, gluePrefixLength: 2 },
        ],
        order: [
          { kind: 'run', runId: 'early' },
          { kind: 'tool', toolEventId: 'read', executionRef: 'turn-1' },
          { kind: 'tool', toolEventId: 'result', executionRef: 'turn-1' },
          { kind: 'run', runId: 'answer' },
        ],
      },
    },
  });
}

let harness: ReplyLayersHarness;
let root: Root;
let host: HTMLDivElement;
let storedMode = 'whole';
let saveFails = false;
beforeAll(installReplyLayersActEnvironment);
afterAll(uninstallReplyLayersActEnvironment);
beforeEach(() => {
  resetProcessTalkPreferenceForTest();
  storedMode = 'whole';
  saveFails = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/config/process-talk') {
      if (init?.method === 'PUT') {
        if (saveFails) return new Response('{}', { status: 503 });
        const body = JSON.parse(String(init.body));
        expect(body.expectedOwnerUserId).toBe('owner');
        storedMode = body.mode;
      }
      return new Response(JSON.stringify({ ownerUserId: 'owner', mode: storedMode }));
    }
    return new Response('{}');
  });
  vi.stubGlobal('crypto', {
    subtle: {
      digest: async (_algorithm: string, bytes: Uint8Array) =>
        Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
    },
  });
  harness = new ReplyLayersHarness();
  harness.enableV2();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  harness.dispose();
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const option = (mode: string) => host.querySelector<HTMLElement>(`[data-testid="process-talk-${mode}"]`);

it('real theme entry defaults whole, folds only after saving, and expands the earlier complete answer in place', async () => {
  const message = reply();
  await act(async () => {
    root.render(<ThemeSettingsPanel />);
    harness.render(message);
  });
  expect(option('whole')?.getAttribute('aria-checked')).toBe('true');
  expect(harness.q('message-bubble')?.textContent).toContain(early);
  expect(harness.q('reply-earlier-toggle')).toBeNull();
  await act(async () => option('record')?.click());
  expect(option('record')?.getAttribute('aria-checked')).toBe('true');
  expect(harness.q('message-bubble')?.textContent).not.toContain(early);
  expect(harness.q('message-bubble')?.textContent).toContain(answer);
  expect(harness.q('reply-earlier-toggle')?.textContent).toContain('前面还有 1 段话');
  let readerObservedCommittedExpansion = false;
  const observeLayout = () => {
    readerObservedCommittedExpansion = Boolean(harness.q('reply-earlier-text')?.textContent?.includes(early));
  };
  window.addEventListener('catcafe:chat-layout-changed', observeLayout);
  harness.click('reply-earlier-toggle');
  window.removeEventListener('catcafe:chat-layout-changed', observeLayout);
  expect(
    readerObservedCommittedExpansion,
    'the reading owner must observe committed expansion before resizing can pin bottom',
  ).toBe(true);
  expect(harness.q('reply-earlier-text')?.textContent).toContain(early);
  expect(harness.q('reply-earlier-text')?.textContent).not.toContain(answer);
  harness.click('reply-record-toggle');
  const record = harness.q('reply-record')?.textContent ?? '';
  expect(record.indexOf(early)).toBeLessThan(record.indexOf('Read original source'));
  expect(message.content).toBe(`${early}\n\n${answer}`);
  await act(async () => option('whole')?.click());
  expect(harness.q('reply-earlier-toggle')).toBeNull();
  expect(harness.q('message-bubble')?.textContent).toContain(early);
});

it('saving failure leaves the previously chosen whole view in effect and explains the failure', async () => {
  await act(async () => {
    root.render(<ThemeSettingsPanel />);
    harness.render(reply());
  });
  saveFails = true;
  await act(async () => option('record')?.click());
  expect(option('whole')?.getAttribute('aria-checked')).toBe('true');
  expect(host.textContent).toContain('未能确认保存');
  expect(harness.q('message-bubble')?.textContent).toContain(early);
});

it('a fresh page reads the saved personal preference; no per-conversation setting is used', async () => {
  storedMode = 'record';
  await act(async () => {
    root.render(<ThemeSettingsPanel />);
    harness.render(reply());
  });
  expect(option('record')?.getAttribute('aria-checked')).toBe('true');
  expect(harness.q('reply-earlier-toggle')).not.toBeNull();
  const reads = vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/config/process-talk');
  expect(reads).toHaveLength(1);
});
