import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
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

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/compressImage', () => ({ compressImage: (file: File) => Promise.resolve(file) }));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ invalidateSidebarProjection: vi.fn(async () => undefined) }));
vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: vi.fn(async () => true), uploadStatus: 'idle', uploadError: null }),
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

const navigate = vi.fn();
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
let container: HTMLDivElement;
let root: Root;
let owner: string;
const owners = new Set<string>();

function Host({ capture }: { capture?: (admission: ReturnType<typeof useNewConversationAdmission>) => void }) {
  const admission = useNewConversationAdmission(navigate);
  capture?.(admission);
  return admission.ready ? (
    <ChatInput
      threadId="default"
      presentation="v2"
      onDraftChange={admission.onDraftChange}
      onSend={(content, images) => admission.send({ content, images })}
    />
  ) : null;
}

async function waitForAct(assertion: () => void | Promise<void>) {
  await vi.waitFor(async () => {
    await act(async () => Promise.resolve());
    await assertion();
  });
}

async function attachImage(file: File) {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error('Missing attachment input');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

beforeEach(() => {
  owner = `draft-navigation-${crypto.randomUUID()}`;
  owners.add(owner);
  threadDrafts.clear();
  threadImageDrafts.clear();
  threadReplyDrafts.clear();
  threadContextAttachmentDrafts.clear();
  useChatStore.setState({
    currentThreadId: 'default',
    threadStates: {},
    pendingChatInsert: null,
    replyToMessage: null,
  });
  installPendingAdmissionServer(owner, { draft: null, revision: 0 }, 'send', () => undefined);
  URL.createObjectURL = vi.fn(() => 'blob:draft-navigation');
  URL.revokeObjectURL = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await Promise.all([...owners].map(clearNewConversationIntent));
  owners.clear();
  _resetNewConversationIntentDbForTests();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.clearAllMocks();
});

it('retains an unsent image after leaving and returning while its local save is pending', async () => {
  await act(async () => root.render(<Host />));
  await waitForAct(async () => expect((await loadNewConversationIntent(owner))?.files).toHaveLength(0));
  const textarea = container.querySelector('textarea');
  if (!textarea) throw new Error('Missing composer');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Missing native textarea setter');
  act(() => {
    setValue.call(textarea, 'keep my unsent caption');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const file = new File(['image-bytes'], 'pending.png', { type: 'image/png' });
  let releaseBytes: (bytes: ArrayBuffer) => void = () => {};
  const pendingBytes = new Promise<ArrayBuffer>((resolve) => (releaseBytes = resolve));
  const readBytes = vi.fn(() => pendingBytes);
  Object.defineProperty(file, 'arrayBuffer', { value: readBytes });
  await attachImage(file);
  await waitForAct(() => expect(readBytes).toHaveBeenCalledOnce());
  expect(container.querySelector('img[alt="pending.png"]')).not.toBeNull();

  await act(async () => root.render(<div>another conversation</div>));
  await act(async () => root.render(<Host />));
  await waitForAct(() =>
    expect(vi.mocked(apiFetch).mock.calls.filter(([url]) => url === '/api/session')).toHaveLength(2),
  );
  await act(async () => {
    // Let the returning host start restoration while the previous image write is still gated.
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseBytes(new TextEncoder().encode('image-bytes').buffer);
  });

  await waitForAct(() => expect(container.querySelector('img[alt="pending.png"]')).not.toBeNull());
  expect(container.querySelector('textarea')?.value).toBe('keep my unsent caption');
  expect(threadImageDrafts.get('default')).toHaveLength(1);
});

it('keeps an explicitly removed image absent after returning to the new conversation', async () => {
  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(container.querySelector('textarea')).not.toBeNull());
  await attachImage(new File(['image-bytes'], 'removed.png', { type: 'image/png' }));
  await waitForAct(async () => expect((await loadNewConversationIntent(owner))?.files).toHaveLength(1));
  const remove = container.querySelector('button[aria-label^="Remove "]');
  if (!remove) throw new Error('Missing image removal button');
  await act(async () => remove.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await waitForAct(async () => expect((await loadNewConversationIntent(owner))?.files).toHaveLength(0));

  await act(async () => root.render(<div>another conversation</div>));
  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(container.querySelector('textarea')).not.toBeNull());
  expect(container.querySelector('img[alt="removed.png"]')).toBeNull();
  expect(threadImageDrafts.has('default')).toBe(false);
});

it("does not restore another owner's images from the unscoped browser mirror", async () => {
  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(container.querySelector('textarea')).not.toBeNull());
  await attachImage(new File(['private-image'], 'owner-a.png', { type: 'image/png' }));
  await waitForAct(async () => expect((await loadNewConversationIntent(owner))?.files).toHaveLength(1));
  await act(async () => root.render(<div>another conversation</div>));

  owner = `draft-navigation-${crypto.randomUUID()}`;
  owners.add(owner);
  installPendingAdmissionServer(owner, { draft: null, revision: 0 }, 'send', () => undefined);
  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(container.querySelector('textarea')).not.toBeNull());

  expect(container.querySelector('img[alt="owner-a.png"]')).toBeNull();
  await waitForAct(async () => expect((await loadNewConversationIntent(owner))?.files).toHaveLength(0));
});

it('retains a failed image on return and retries only after an explicit action', async () => {
  const captured = { current: null as ReturnType<typeof useNewConversationAdmission> | null };
  const capture = (admission: ReturnType<typeof useNewConversationAdmission>) => (captured.current = admission);
  await act(async () => root.render(<Host capture={capture} />));
  await waitForAct(() => expect(container.querySelector('textarea')).not.toBeNull());
  const file = new File(['image-bytes'], 'failed.png', { type: 'image/png' });
  const readBytes = vi
    .fn()
    .mockRejectedValueOnce(new Error('image read failed'))
    .mockResolvedValue(new TextEncoder().encode('image-bytes').buffer);
  Object.defineProperty(file, 'arrayBuffer', { value: readBytes });
  await attachImage(file);
  await waitForAct(() => expect(captured.current?.localSaveState).toBe('failed'));

  await act(async () => root.render(<div>another conversation</div>));
  await act(async () => root.render(<Host capture={capture} />));
  await waitForAct(() => expect(container.querySelector('textarea')).not.toBeNull());
  expect(container.querySelector('img[alt="failed.png"]')).not.toBeNull();
  expect(captured.current?.localSaveState).toBe('failed');
  expect(readBytes).toHaveBeenCalledOnce();

  act(() => captured.current?.retrySave());
  await waitForAct(() => expect(captured.current?.localSaveState).toBe('idle'));
  expect((await loadNewConversationIntent(owner))?.files).toHaveLength(1);
  expect(readBytes).toHaveBeenCalledTimes(2);
});

it('stops preparing the first send when its unfinished local save is cancelled', async () => {
  const captured = { current: null as ReturnType<typeof useNewConversationAdmission> | null };
  await act(async () => root.render(<Host capture={(admission) => (captured.current = admission)} />));
  await waitForAct(() => expect(container.querySelector('textarea')).not.toBeNull());
  let releaseBytes: (bytes: ArrayBuffer) => void = () => {};
  const bytes = new Promise<ArrayBuffer>((resolve) => (releaseBytes = resolve));
  const readBytes = vi.fn(() => bytes);
  const file = new File(['image-bytes'], 'pending-send.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: readBytes });
  await attachImage(file);
  await waitForAct(() => expect(readBytes).toHaveBeenCalledOnce());
  const admission = captured.current;
  if (!admission) throw new Error('Missing admission controller');
  let sending = Promise.resolve(true);
  let sendResult: boolean | undefined;
  try {
    act(() => {
      sending = admission.send({ content: 'keep my draft', images: [file] });
      void sending.then((result) => (sendResult = result));
    });
    await waitForAct(() => expect(captured.current?.phase).toBe('creating'));
    act(() => admission.cancelSave());
    await waitForAct(() => expect(sendResult).toBe(false));
    expect(captured.current?.phase).toBe('idle');
    expect(captured.current?.localSaveState).toBe('cancelled');
    expect(container.querySelector('img[alt="pending-send.png"]')).not.toBeNull();
    expect(
      vi.mocked(apiFetch).mock.calls.some(([url, options]) => url === '/api/threads' && options?.method === 'POST'),
    ).toBe(false);
  } finally {
    releaseBytes(new TextEncoder().encode('image-bytes').buffer);
    await sending;
  }
});
