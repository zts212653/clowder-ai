import type { ContextAttachment } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { ChatInput } from '../ChatInput';
import { syncContextAttachmentDraftToStorage, syncDraftToStorage } from '../thread-drafts';

vi.mock('@/hooks/useVoiceInput', () => ({ useVoiceInput: () => ({ state: 'idle', transcript: '', error: null }) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(async () => new Response('{}', { status: 200 })) }));

const digest: `sha256:${string}` = `sha256:${'a'.repeat(64)}`;
const contexts: ContextAttachment[] = [
  { v: 1, kind: 'thread', id: 'original-thread', threadId: 'earlier', title: 'Original thread context' },
  { v: 1, kind: 'workspace_file', id: 'original-file', path: 'notes.md', worktreeId: 'root', revision: digest },
  {
    v: 1,
    kind: 'project-screening',
    id: 'frozen-mark',
    title: 'Frozen movie',
    contentRef: 'project-1',
    screeningId: 'screening-1',
    input: { contentRef: 'project-1', ownerRevision: 1, blobDigest: digest },
    media: { contentRef: 'movie-1', ownerRevision: 1, blobDigest: digest },
    selections: [{ id: 'place', mediaRange: { startPts: 0, endPts: 1 }, target: { kind: 'project' } }],
  },
];
let host: HTMLDivElement;
let root: Root;
beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(() => {
  useActiveExecutionStore.getState().reset();
  useChatStore.setState({
    currentThreadId: 'original-input',
    hasActiveInvocation: false,
    activeInvocations: {},
    catInvocations: {},
    targetCats: [],
    pendingChatInsert: null,
    replyToMessage: null,
  });
  syncDraftToStorage('original-input', 'Keep original words');
  syncContextAttachmentDraftToStorage('original-input', contexts);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  syncDraftToStorage('original-input', undefined);
  syncContextAttachmentDraftToStorage('original-input', []);
});

it.each([
  'classic',
  'v2',
] as const)('the original %s composer sends supported original contexts with the exact frozen screening identity', async (presentation) => {
  const send = vi.fn(() => false);
  await act(async () => root.render(<ChatInput presentation={presentation} threadId="original-input" onSend={send} />));
  const textarea = host.querySelector('textarea');
  expect(textarea?.value).toBe('Keep original words');
  await act(async () =>
    textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
  );
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith('Keep original words', undefined, undefined, undefined, contexts);
  expect(textarea?.value, 'A declined local admission retains the original draft').toBe('Keep original words');
});
