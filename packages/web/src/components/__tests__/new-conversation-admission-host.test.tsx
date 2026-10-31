import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  ChatInput,
  threadContextAttachmentDrafts,
  threadDrafts,
  threadImageDrafts,
  threadReplyDrafts,
} from '@/components/ChatInput';
import {
  _resetNewConversationIntentDbForTests,
  clearNewConversationIntent,
  loadNewConversationIntent,
} from '@/components/new-conversation/new-conversation-intent-store';
import { useNewConversationAdmission } from '@/components/new-conversation/useNewConversationAdmission';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import {
  type AdmissionDraftServerState,
  type AdmissionServerDraft,
  admissionResponse,
  installAcceptedRecoveryServer,
  installPendingAdmissionServer,
} from './new-conversation-admission-host-fixture';

vi.mock('@/components/icons/SendIcon', () => ({
  SendIcon: () => React.createElement('span', null, 'send'),
}));
vi.mock('@/components/icons/LoadingIcon', () => ({
  LoadingIcon: () => React.createElement('span', null, 'loading'),
}));
vi.mock('@/components/icons/AttachIcon', () => ({
  AttachIcon: () => React.createElement('span', null, 'attach'),
}));
vi.mock('@/utils/compressImage', () => ({ compressImage: (file: File) => Promise.resolve(file) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({
    name: 'ME',
    aliases: [],
    mentionPatterns: ['@co-creator'],
    color: { primary: '#D4A76A', secondary: '#FFF8F0' },
  }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      {
        id: 'opus',
        displayName: '布偶猫',
        color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
        mentionPatterns: ['布偶猫'],
        clientId: 'anthropic',
        defaultModel: 'opus',
        avatar: '/a.png',
        roleDescription: 'dev',
        personality: 'kind',
      },
    ],
    isLoading: false,
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ invalidateSidebarProjection: vi.fn(async () => undefined) }));

const sendMocks = vi.hoisted(() => ({ handleSend: vi.fn(async () => true) }));
vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({
    handleSend: sendMocks.handleSend,
    uploadStatus: 'idle',
    uploadError: null,
  }),
}));

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let container: HTMLDivElement;
let root: Root;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const owner = 'sol61-review-owner';

beforeEach(() => {
  threadDrafts.clear();
  threadImageDrafts.clear();
  threadReplyDrafts.clear();
  threadContextAttachmentDrafts.clear();
  window.sessionStorage.removeItem('cat-cafe:thread-context-attachment-drafts');
  useChatStore.setState({
    currentThreadId: 'default',
    hasDraft: false,
    threadStates: {},
    pendingChatInsert: null,
    replyToMessage: null,
  });
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (typeof url === 'string' && url.endsWith('/composer-draft')) {
      if (!init || init.method === 'GET') return admissionResponse({ draft: null, revision: 0 });
      if (init.method === 'DELETE') {
        const request = JSON.parse(String(init.body)) as { expectedRevision: number };
        return admissionResponse({ cleared: true, revision: request.expectedRevision + 1 });
      }
      const request = JSON.parse(String(init.body)) as { expectedRevision: number; text: string };
      return admissionResponse({
        draft: {
          version: 1,
          ownerUserId: 'u1',
          threadId: url.split('/')[3],
          revision: request.expectedRevision + 1,
          text: request.text,
          updatedAt: Date.now(),
        },
      });
    }
    return admissionResponse({});
  });
  URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name ?? 'image'}`);
  URL.revokeObjectURL = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.useRealTimers();
  vi.clearAllMocks();
  await clearNewConversationIntent(owner);
  _resetNewConversationIntentDbForTests();
});

function getTextarea(): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

function getFileInput(): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!nativeSetter) throw new Error('Missing native textarea value setter');
  nativeSetter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function makeImageFile(name: string): File {
  return new File([`fake-${name}`], name, { type: 'image/png' });
}

async function waitForAct(assertion: () => void | Promise<void>) {
  await vi.waitFor(async () => {
    await act(async () => Promise.resolve());
    await assertion();
  });
}

async function attachFiles(files: File[]) {
  const input = getFileInput();
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

let latest: ReturnType<typeof useNewConversationAdmission>;
const navigate = vi.fn();

function Host() {
  latest = useNewConversationAdmission(navigate);
  return latest.ready ? (
    <ChatInput
      threadId="default"
      presentation="v2"
      disabled={latest.phase === 'creating' || latest.phase === 'sending'}
      onDraftChange={latest.onDraftChange}
      onSend={(content, images, whisper, replyToId, contextAttachments, explicitTargetCats) =>
        latest.send({ content, images, whisper, replyToId, contextAttachments, explicitTargetCats })
      }
    />
  ) : null;
}

it.each([
  'create',
  'send',
] as const)('retains unsent files across refresh while %s is unresolved in the actual composer host', async (pendingStep) => {
  let rejectPending: ((error: unknown) => void) | undefined;
  const draftServer: AdmissionDraftServerState = { draft: null, revision: 0 };
  if (pendingStep === 'send') {
    sendMocks.handleSend.mockImplementationOnce(
      () => new Promise<boolean>((_resolve, reject) => (rejectPending = reject)),
    );
  }
  installPendingAdmissionServer(owner, draftServer, pendingStep, (reject) => (rejectPending = reject));

  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(getTextarea()).not.toBeNull());
  await act(async () => typeInto(getTextarea(), 'keep first message'));
  await attachFiles([makeImageFile('first.png')]);
  await waitForAct(async () => expect((await loadNewConversationIntent(owner))?.files).toHaveLength(1));
  await act(async () => getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await waitForAct(() => expect(rejectPending).toBeTypeOf('function'));

  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const durable = await loadNewConversationIntent(owner);
    await act(async () => root.render(<div>navigate away</div>));
    threadImageDrafts.clear();
    await act(async () => root.render(<Host />));
    await waitForAct(() => expect(getTextarea().value).toBe('keep first message'));
    expect(durable?.files).toHaveLength(1);
  } finally {
    await act(async () => rejectPending?.(new Error('cleanup rejection')));
  }
});

it('clears accepted first message from the durable composer before navigating away', async () => {
  const serverState: { draft: AdmissionServerDraft | null } = { draft: null };
  let revision = 0;
  navigate.mockReset();
  navigate.mockImplementation(() => root.render(<div>real thread</div>));
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (url === '/api/session') return admissionResponse({ userId: owner });
    if (url === '/api/projects/cwd') return admissionResponse({ path: '/work/cafe' });
    if (url === '/api/threads') return admissionResponse({ id: 'created' }, 201);
    if (String(url).endsWith('/composer-draft')) {
      if (!init || init.method === 'GET') return admissionResponse({ draft: serverState.draft, revision });
      if (init.method === 'DELETE') {
        serverState.draft = null;
        return admissionResponse({ cleared: true, revision: ++revision });
      }
      const request = JSON.parse(String(init.body)) as { text: string };
      serverState.draft = {
        version: 1,
        ownerUserId: owner,
        threadId: 'default',
        revision: ++revision,
        text: request.text,
        updatedAt: Date.now(),
      };
      return admissionResponse({ draft: serverState.draft });
    }
    return admissionResponse({});
  });

  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(getTextarea()).not.toBeNull());
  await act(async () => typeInto(getTextarea(), 'accepted first message'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  expect(serverState.draft?.text).toBe('accepted first message');
  await act(async () => getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await waitForAct(() => expect(navigate).toHaveBeenCalledWith('created'));
  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(getTextarea()).not.toBeNull());
  expect(getTextarea().value).toBe('');
});

it('retries an accepted cleanup failure without resending and preserves a newer revision', async () => {
  const state: AdmissionDraftServerState = { draft: null, revision: 0 };
  const deleteRevisions: number[] = [];
  navigate.mockReset();
  navigate.mockImplementation(() => root.render(<div>real thread</div>));
  installAcceptedRecoveryServer(owner, state, deleteRevisions);

  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(getTextarea()).not.toBeNull());
  await act(async () => typeInto(getTextarea(), 'send before autosave'));
  await act(async () => getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await waitForAct(() => expect(navigate).toHaveBeenCalledTimes(1));
  expect(await loadNewConversationIntent(owner)).toMatchObject({
    intent: { messageAccepted: true, composerDraftAdmission: { expectedRevision: 1 } },
  });
  expect(sendMocks.handleSend).toHaveBeenCalledOnce();

  state.draft = {
    version: 1,
    ownerUserId: owner,
    threadId: 'default',
    revision: ++state.revision,
    text: 'newer other-tab draft',
    updatedAt: Date.now(),
  };
  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(navigate).toHaveBeenCalledTimes(2));
  expect(await loadNewConversationIntent(owner)).toBeNull();
  expect(deleteRevisions).toEqual([1, 1]);
  expect(state.draft?.text).toBe('newer other-tab draft');

  await act(async () => root.render(<Host />));
  await waitForAct(() => expect(getTextarea().value).toBe('newer other-tab draft'));
  expect(sendMocks.handleSend).toHaveBeenCalledOnce();
});
