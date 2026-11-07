import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
import { LocalDraftSaveNotice } from '@/components/new-conversation/LocalDraftSaveNotice';
import {
  _resetNewConversationIntentDbForTests,
  clearNewConversationIntent,
  loadNewConversationIntent,
} from '@/components/new-conversation/new-conversation-intent-store';
import { useNewConversationAdmission } from '@/components/new-conversation/useNewConversationAdmission';
import {
  threadContextAttachmentDrafts,
  threadDrafts,
  threadImageDrafts,
  threadReplyDrafts,
} from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { installPendingAdmissionServer } from './new-conversation-admission-host-fixture';

const boundary = vi.hoisted(() => ({
  beforePut: null as (() => Promise<void>) | null,
  writes: 0,
  handleSend: vi.fn(async () => true),
}));

// Keep real IndexedDB and delay only the storage module's put boundary.
vi.mock('idb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('idb')>();
  return {
    ...actual,
    openDB: async (...args: Parameters<typeof actual.openDB>) => {
      const database = await actual.openDB(...args);
      return new Proxy(database, {
        get(target, property) {
          if (property === 'put') {
            return async (...values: Parameters<typeof database.put>) => {
              boundary.writes += 1;
              await boundary.beforePut?.();
              return database.put(...values);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/compressImage', () => ({ compressImage: (file: File) => Promise.resolve(file) }));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ invalidateSidebarProjection: vi.fn(async () => undefined) }));
vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: boundary.handleSend, uploadStatus: 'idle', uploadError: null }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], isLoading: false, getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));
vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorDisplay: () => ({ name: 'ME', nickname: 'co-creator', role: 'operator', mention: '@co-creator' }),
  useCoCreatorConfig: () => ({
    name: 'ME',
    aliases: [],
    mentionPatterns: ['@co-creator'],
    color: { primary: '#D4A76A', secondary: '#FFF8F0' },
  }),
}));

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useNewConversationAdmission>;
let owner: string;
let observedSend: Promise<boolean> | null;
const navigate = vi.fn();
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function Host() {
  latest = useNewConversationAdmission(navigate);
  return latest.ready ? (
    <>
      <ChatInput
        threadId="default"
        presentation="v2"
        onDraftChange={latest.onDraftChange}
        onSend={(content, images) => {
          observedSend = latest.send({ content, images });
          return observedSend;
        }}
      />
      {latest.localSaveState !== 'idle' && (
        <LocalDraftSaveNotice state={latest.localSaveState} onCancel={latest.cancelSave} onRetry={latest.retrySave} />
      )}
    </>
  ) : null;
}

async function waitForAct(assertion: () => void | Promise<void>) {
  await vi.waitFor(async () => {
    await act(async () => Promise.resolve());
    await assertion();
  });
}

beforeEach(async () => {
  owner = `cancel-phases-${crypto.randomUUID()}`;
  boundary.beforePut = null;
  boundary.writes = 0;
  observedSend = null;
  URL.createObjectURL = vi.fn(() => 'blob:cancel-save-test');
  URL.revokeObjectURL = vi.fn();
  threadDrafts.clear();
  threadImageDrafts.clear();
  threadContextAttachmentDrafts.clear();
  threadReplyDrafts.clear();
  useChatStore.setState({
    currentThreadId: 'default',
    threadStates: {},
    pendingChatInsert: null,
    replyToMessage: null,
  });
  installPendingAdmissionServer(owner, { draft: null, revision: 0 }, 'send', () => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(latest.ready).toBe(true));
  await waitForAct(async () => {
    expect((await loadNewConversationIntent(owner))?.files).toHaveLength(0);
    expect(latest.localSaveState).toBe('idle');
  });
  boundary.writes = 0;
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  boundary.beforePut = null;
  await clearNewConversationIntent(owner);
  _resetNewConversationIntentDbForTests();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.clearAllMocks();
});

it.each([
  { phase: 'reading', assertBeforeRelease: true, cancelRequested: true },
  { phase: 'queued', assertBeforeRelease: true, cancelRequested: true },
  { phase: 'writing', assertBeforeRelease: true, cancelRequested: true },
  { phase: 'writing', assertBeforeRelease: false, cancelRequested: true },
  { phase: 'writing', assertBeforeRelease: false, cancelRequested: false },
] as const)('first send during $phase (cancel: $cancelRequested; check before release: $assertBeforeRelease)', async ({
  phase,
  assertBeforeRelease,
  cancelRequested,
}) => {
  const textarea = container.querySelector('textarea');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!textarea || !setValue) throw new Error('Missing composer');
  act(() => {
    setValue.call(textarea, 'keep this draft');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitForAct(() => expect(latest.localSaveState).toBe('idle'));
  boundary.writes = 0;
  const gate = Promise.withResolvers<void>();
  const bytes = Promise.withResolvers<ArrayBuffer>();
  const file = new File(['image'], `${phase}.png`, { type: 'image/png' });
  const readBytes = vi.fn(() => bytes.promise);
  Object.defineProperty(file, 'arrayBuffer', { value: readBytes });
  if (phase !== 'reading') boundary.beforePut = () => gate.promise;
  if (phase === 'queued') {
    act(() => latest.updateTitle('older save'));
    await waitForAct(() => expect(boundary.writes).toBe(1));
  }
  if (phase !== 'reading') bytes.resolve(new TextEncoder().encode('image').buffer);
  let sending = Promise.resolve(false);
  let result: boolean | undefined;
  try {
    const input = container.querySelector('input[type="file"]');
    if (!input) throw new Error('Missing image input');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await waitForAct(() => expect(readBytes).toHaveBeenCalledOnce());
    if (phase === 'writing') await waitForAct(() => expect(boundary.writes).toBe(1));
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    if (!observedSend) throw new Error('Composer did not request the first send');
    sending = observedSend;
    void sending.then((value) => (result = value));
    await waitForAct(() => expect(latest.phase).toBe('creating'));
    const cancel = container.querySelector<HTMLButtonElement>('[data-testid="new-conversation-cancel-save"]');
    if (!cancel) throw new Error('Missing cancel action');
    expect(cancel.disabled).toBe(false);
    if (cancelRequested) act(() => cancel.click());
    if (assertBeforeRelease) {
      // Neither gate is released: cancellation must settle the request now.
      await waitForAct(() => expect(result).toBe(false));
      expect(boundary.handleSend).not.toHaveBeenCalled();
      expect(vi.mocked(apiFetch).mock.calls.some(([url]) => url === '/api/threads')).toBe(false);
      expect((await loadNewConversationIntent(owner))?.files.map((image) => image.name)).toEqual([`${phase}.png`]);
    }
  } finally {
    bytes.resolve(new TextEncoder().encode('image').buffer);
    boundary.beforePut = null;
    gate.resolve();
    await act(async () => {
      await sending;
      await loadNewConversationIntent(owner);
    });
  }
  expect(
    result,
    JSON.stringify({
      phase: latest.phase,
      save: latest.localSaveState,
      calls: vi.mocked(apiFetch).mock.calls.map(([url, init]) => [url, init?.method]),
    }),
  ).toBe(!cancelRequested);
  expect(boundary.handleSend).toHaveBeenCalledTimes(cancelRequested ? 0 : 1);
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => url === '/api/threads')).toBe(!cancelRequested);
  expect(navigate).toHaveBeenCalledTimes(cancelRequested ? 0 : 1);
});
