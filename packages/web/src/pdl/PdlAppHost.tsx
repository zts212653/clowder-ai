'use client';

import type { ArtifactReviewAnchor } from '@cat-cafe/shared';
import {
  type ContextAttachment,
  ContextAttachmentsSchema,
  type MessageContent,
  RichCardBlock,
  RuntimeInteractionRecord,
  RuntimeInteractionResponse,
} from '@cat-cafe/shared';
import { usePathname } from 'next/navigation';
import {
  type MutableRefObject,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { resolveAssetUrl } from '@/components/artifacts/artifact-view';
import { type ContextFileHit, searchWorkspaceContextFiles } from '@/components/chat-context-file-search';
import {
  createFileContextAttachment,
  createQuoteContextAttachment,
  createThreadContextAttachment,
} from '@/components/chat-context-reference';
import { applyContextAttachmentDelta } from '@/components/composer-queue';
import {
  addMediaSelection,
  addMediaWork,
  MEDIA_SELECTION_REFUSAL_COPY,
  type MediaChatTarget,
} from '@/components/content-review/media-chat-selection';
import { uploadAvatarAsset, uploadRefAudioAsset } from '@/components/hub-cat-editor.client';
import { initialState } from '@/components/hub-cat-editor.model';
import {
  createForwardIdempotencyKey,
  forwardPayloadFingerprint,
  submitMessageBundleForward,
} from '@/components/message-bundle-forwarding';
import { selectMessagesForExport } from '@/components/message-export-selection';
import { useMessageSearch } from '@/components/message-search/useMessageSearch';
import {
  type NewConversationAdmission,
  useNewConversationAdmission,
} from '@/components/new-conversation/useNewConversationAdmission';
import { useScheduleApprovalController } from '@/components/rich/useScheduleApprovalController';
import { mutationRequestOptions } from '@/components/settings/plugin-manager/plugin-manager-mutation-options';
import {
  readPinnedProjects,
  readProjectNames,
  writePinnedProjects,
  writeProjectNames,
} from '@/components/ThreadSidebar/active-workspace';
import {
  getThreadIdFromPathname,
  pushThreadRouteWithHistory,
  subscribeBrowserThreadRoute,
} from '@/components/ThreadSidebar/thread-navigation';
import { projectDisplayName } from '@/components/ThreadSidebar/thread-utils';
import { useHubSocket } from '@/components/thread-chat/hub-socket-context';
import { ThreadChatRuntimeProvider, useThreadChatRuntime } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import {
  getContextAttachmentDraft,
  getThreadDraft,
  hasLegacyThreadDraft,
  hasPendingThreadDraft,
  readVerifiedLegacyThreadDraft,
  subscribeContextAttachmentDrafts,
  subscribeThreadDrafts,
  syncContextAttachmentDraftToStorage,
  syncDraftToStorage,
  syncReplyDraftToStorage,
  threadImageDrafts,
  threadReplyDrafts,
} from '@/components/thread-drafts';
import { useCloudBindingRecovery } from '@/components/useCloudBindingRecovery';
import { useCloudReply } from '@/components/useCloudReply';
import { reconcileThreadWithServer } from '@/hooks/queue-reconciliation';
import { cancelProjectedExecution, useActiveExecutionProjection } from '@/hooks/useActiveExecutionProjection';
import { type CatData, refreshCatsNow, useCatData } from '@/hooks/useCatData';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import { usePluginTargets } from '@/hooks/usePluginMentionTargets';
import { type RoutingPreviewState, useRoutingPreview } from '@/hooks/useRoutingPreview';
import { type RoutingConfirmation, useSendMessage } from '@/hooks/useSendMessage';
import { useTts } from '@/hooks/useTts';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { useWorkspace } from '@/hooks/useWorkspace';
import { fetchApprovalProducerBody } from '@/lib/approval-producer-read';
import { readApprovalResultOwner } from '@/lib/approval-result-owner';
import { isDshMember } from '@/lib/member-model-display';
import { useApprovalResult } from '@/lib/use-approval-result';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { useInputHistoryStore } from '@/stores/inputHistoryStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { initSidebarWidth, useSidebarStore } from '@/stores/sidebarStore';
import { useToastStore } from '@/stores/toastStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import { type ApiSessionIdentity, apiSessionIdentity } from '@/utils/api-session-identity';
import { notifyHandledMentionRead } from '@/utils/mention-read-receipt';
import { invalidateSidebarProjection, refreshSidebarThreadSnapshot } from '@/utils/sidebar-thread-snapshot';
import { invalidateThreadAttentionPreferences } from '@/utils/thread-attention-invalidation';
import { composerInsertFromRecall, requestTrueRecall } from '@/utils/true-recall';
import { getUserId } from '@/utils/userId';
import { type ChatData, composerTrigger } from './chat-models';
import { type CloudRecoveryBinding, type CloudRecoveryTarget, cloudRecoveryTargets } from './cloud-models';
import { readThreadExportAddress } from './export-route';
import { submitInteractiveGroup } from './interactive-actions';
import {
  createNativeMember,
  pickMemberTemplate,
  prepareNativePartner,
  readMemberCanon,
  readMemberClientSettings,
  readMemberRuntimeModels,
  readMemberSettings,
  readNativeMembers,
  readVoiceChoices,
  removeMember,
  runMemberProviderSetup,
  saveMember,
  saveMemberCanon,
  saveMemberClientSettings,
  saveMemberOrder,
  saveMemberStrategy,
  saveOwner,
  setMemberAvailable,
} from './member-actions';
import {
  decideMemoryMessage,
  type MemoryMessageBinding,
  MemoryMessageOwnerBinding,
  resolveMemoryEntity,
} from './memory-message-proposals';
import { messageCards } from './message-cards';
import {
  cliQuoteSelection,
  type MessageQuoteSelection,
  messageQuoteSelection,
  selectedItems,
  wholeSelection,
} from './message-selection';
import { request, write } from './owner-api';
import { type ProjectBindings, ProjectDataBinding } from './ProjectDataBinding';
import { downloadPayload, richRender, terminal } from './platform';
import { callPluginOperation, readPluginSpaces, readPluginSubtree } from './plugin-spaces';
import type { ScheduleBinding } from './proposal-models';
import {
  decideProposal,
  type ProposalBinding,
  type ProposalTarget,
  proposalFromBody,
  proposalPath,
  proposalView,
  readProposal,
  recheckProposal,
  requestProposalRevision,
} from './proposal-models';
import { mountChat } from './runtime';
import {
  type QuestionBinding,
  readRuntimeRecord,
  runtimeFieldKey,
  runtimeResponse,
  submitRuntimeAnswers,
} from './runtime-questions';
import {
  readPushClient,
  removeMcp,
  resetInjectionSegment,
  saveAccount,
  saveCapability,
  saveInjectionSegment,
  saveMountRules,
  saveThreadEffort,
  saveThreadGoal,
  saveThreadSpeed,
  subscribePush,
  unsubscribePush,
} from './settings-actions';
import { renameThreadTitleOptimistic } from './thread-rename';
import type { ChatPort, ChatUiState, SidebarSnapshot } from './types';
import { useConsoleCommandBindings } from './useConsoleCommandBindings';
import { useBrakeBindings } from './useOpsBindings';
import { useReplyBindings } from './useReplyBindings';
import { type DraftFile, useServerComposerDraft } from './useServerComposerDraft';

const confirmRouting: RoutingConfirmation = (request) => window.clowderChat.confirm('routingRedirect', request);

function subscribeLocation(changed: () => void) {
  const release = subscribeBrowserThreadRoute(changed);
  window.addEventListener('hashchange', changed);
  return () => {
    release();
    window.removeEventListener('hashchange', changed);
  };
}
const browserLocation = () => window.location.pathname + window.location.search + window.location.hash;
// The server render has no address after #; the console starts once the browser's full address (an export page) is known.
const subscribeNever = () => () => {};
type PendingThreadJump = { threadId: string; mid: string; catId?: string; block?: string };

/** The uploaded attachment a file in the input came from (a saved draft's image or file): the draft keeps it as is. */
const draftFile = new WeakMap<File, DraftFile>();

/** Message images as files again, for a retry or a recalled message going back into the input. */
async function downloadImages(urls: readonly string[], blocks: readonly MessageContent[] = []): Promise<File[]> {
  return Promise.all(
    urls.slice(0, 5).map(async (url, index) => {
      const response = await apiFetch(url);
      if (!response.ok) throw new Error('原图片未完整读取，请重试');
      const blob = await response.blob();
      const descriptor = blocks.find((block) => block.type === 'file' && block.url === url);
      if (descriptor?.type === 'file' && blob.size !== descriptor.fileSize) throw new Error('attachment_size_mismatch');
      const ext = url.split('.').pop() ?? 'png';
      return new File(
        [blob],
        descriptor?.type === 'file' ? descriptor.fileName : `recalled-${Date.now()}-${index}.${ext}`,
        { type: descriptor?.type === 'file' ? descriptor.mimeType : blob.type || `image/${ext}` },
      );
    }),
  );
}

/** Fill remaining slots without removing already saved draft attachments. */
export function fitRestoredComposerAttachments(restored: File[], added: File[]) {
  const files = [...restored, ...added].slice(0, 5);
  return { files, omitted: restored.length + added.length - files.length };
}

function subscribeDraftOwner(onChange: () => void): () => void {
  const stopText = subscribeThreadDrafts(onChange),
    stopContext = subscribeContextAttachmentDrafts(onChange);
  return () => {
    stopText();
    stopContext();
  };
}

/** The last send attempt per conversation (its key and what was sent), kept with the draft across a reload. */
type SendAttempt = { key: string; signature: string };
const SEND_ATTEMPTS = 'pdl-send-attempts';
function readSendAttempt(threadId: string): SendAttempt | undefined {
  return (JSON.parse(sessionStorage.getItem(SEND_ATTEMPTS) || '{}') as Record<string, SendAttempt>)[threadId];
}
function writeSendAttempt(threadId: string, attempt: SendAttempt | null) {
  const all = JSON.parse(sessionStorage.getItem(SEND_ATTEMPTS) || '{}') as Record<string, SendAttempt>;
  if (attempt) all[threadId] = attempt;
  else delete all[threadId];
  sessionStorage.setItem(SEND_ATTEMPTS, JSON.stringify(all));
}

/**
 * Sends one conversation's draft. The draft stays where it is until the server takes it: `hold` locks that
 * conversation's input meanwhile, a refused or failed send changes nothing, and sending the same content
 * again reuses the attempt key so the server recognises an attempt that did arrive. Only a taken send clears.
 */
export async function sendHeldDraft(input: {
  threadId: string;
  owner?: string;
  signature: string;
  keyed: boolean;
  send: (attemptKey: string) => Promise<unknown>;
  hold: (on: boolean) => void;
  clear: () => void;
}): Promise<boolean> {
  const attemptScope = JSON.stringify([input.owner, input.threadId]);
  const prior = readSendAttempt(attemptScope);
  const key = prior?.signature === input.signature ? prior.key : crypto.randomUUID();
  if (input.keyed) writeSendAttempt(attemptScope, { key, signature: input.signature });
  input.hold(true);
  try {
    if ((await input.send(key)) === false) return false;
    writeSendAttempt(attemptScope, null);
    input.clear();
    return true;
  } finally {
    input.hold(false);
  }
}

export function PdlAppHost() {
  const pathname = usePathname() || '/';
  const browserPath = useSyncExternalStore(subscribeLocation, browserLocation, () => pathname);
  const inBrowser = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  const exportAddress = readThreadExportAddress(new URL(browserPath, 'https://pdl.invalid'));
  const threadId = exportAddress?.threadId ?? getThreadIdFromPathname(browserPath);
  const pendingJump = useRef<PendingThreadJump | null>(null);
  // An address that names a message (/thread/:id?message=…&block=… — links in messages, matter sources) opens that
  // thread at that message, and at that card part when it names one, through the same jump as an in-app link. Each
  // address is taken once.
  const addressJump = useRef('');
  const addressQuery = new URL(browserPath, 'https://pdl.invalid').searchParams;
  const addressMid = addressQuery.get('message') ?? addressQuery.get('messageId');
  const addressBlock = addressQuery.get('block');
  if (addressMid && addressJump.current !== browserPath) {
    addressJump.current = browserPath;
    pendingJump.current = { threadId, mid: addressMid, ...(addressBlock ? { block: addressBlock } : {}) };
  }
  // Where the reader is: once the conversation stops scrolling, the address names the message at the middle of the
  // view (?message=…), or nothing at the latest. A refresh reopens there through the same address jump, which puts
  // that message in the middle again, so the record stays put; writing the address is not itself a jump.
  useEffect(() => {
    const settle = (event: Event) => {
      const stream = event.target;
      if (!(stream instanceof HTMLElement) || stream.id !== 'stream') return;
      const url = new URL(window.location.href);
      if (!url.pathname.startsWith('/thread/')) return;
      const view = stream.getBoundingClientRect(),
        middle = (view.top + view.bottom) / 2;
      const message =
        -stream.scrollTop <= 2
          ? undefined
          : [
              ...stream.querySelectorAll<HTMLElement>('[data-stream] > [data-mid], [data-stream] > [data-message-id]'),
            ].find((m) => m.getBoundingClientRect().bottom >= middle);
      const mid = message?.dataset.mid ?? message?.dataset.messageId;
      url.searchParams.delete('messageId');
      url.searchParams.delete('block');
      if (mid) url.searchParams.set('message', mid);
      else url.searchParams.delete('message');
      const next = url.pathname + url.search + url.hash;
      if (next === browserLocation()) return;
      addressJump.current = next;
      window.history.replaceState(window.history.state, '', next);
    };
    document.addEventListener('scrollend', settle, true);
    return () => document.removeEventListener('scrollend', settle, true);
  }, []);
  const [needed, setNeeded] = useState<ReadonlySet<string>>(new Set());
  return (
    <ThreadChatRuntimeProvider routeThreadId={threadId} neededSources={needed}>
      <div id="app" />
      {inBrowser && (
        <ChatBinding
          key={browserPath.includes('#export-') ? browserPath : 'console'}
          threadId={threadId}
          pendingJump={pendingJump}
          needed={needed}
          setNeeded={setNeeded}
          exportMids={exportAddress?.mids}
        />
      )}
    </ThreadChatRuntimeProvider>
  );
}

/** Mark the conversation being left without notifying the sidebar on each edit. */
export function useThreadDraftMarker(threadId: string, session = apiSessionIdentity.getSnapshot()) {
  const leaving = useMemo(() => ({ current: false, hasCommittedText: false }), [threadId, session]);
  const setThreadHasDraft = useChatStore((state) => state.setThreadHasDraft);
  useLayoutEffect(
    () => () => {
      if (apiSessionIdentity.getSnapshot() === session) setThreadHasDraft(threadId, leaving.current);
    },
    [threadId, leaving, session, setThreadHasDraft],
  );
  return leaving;
}

function ChatBinding({
  threadId,
  pendingJump,
  exportMids,
  needed,
  setNeeded,
}: {
  threadId: string;
  exportMids?: readonly string[] | null;
  needed: ReadonlySet<string>;
  setNeeded: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  pendingJump: MutableRefObject<PendingThreadJump | null>;
}) {
  const { socketConnected, registerIndexEventHandler } = useThreadChatRuntime([threadId]);
  const session = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    apiSessionIdentity.getSnapshot,
    apiSessionIdentity.getSnapshot,
  );
  const displayedSession = useRef(session);
  const neededNow = useRef(needed);
  neededNow.current = needed;
  // Reconnect makes the same needed sources appear again without losing their held data.
  const [readGeneration, setReadGeneration] = useState(1);
  const need = (source: string) =>
    [...needed].some((key) => key === source || key.startsWith(source + '.')) ? readGeneration : false;
  const history = useChatHistory(threadId, { tasks: false, needed: need('chat.messages') });
  const connection = useConnectionStatus(
    socketConnected,
    need('chat.readonly') || need('chat.forwardingBlocked') || need('chat.updateRequired'),
  );
  const loadEarlier = history.loadEarlier;
  const surfaceMessages = useMemo(
    () =>
      exportMids === undefined
        ? history.messages
        : selectMessagesForExport(history.messages, exportMids ?? []).messages,
    [history.messages, exportMids],
  );
  const { cats, isLoading: catsLoading } = useCatData();
  const hub = useHubSocket();
  const me = useCoCreatorConfig();
  const search = useMessageSearch(threadId);
  const inputHistory = useInputHistoryStore(useShallow((s) => ({ entries: s.entries, addEntry: s.addEntry })));
  const voice = useVoiceInput();
  const replyOutput = useReplyBindings(surfaceMessages, threadId);
  const speech = useTts();
  const { handleSend, uploadStatus, uploadError } = useSendMessage(threadId, confirmRouting);
  const store = useChatStore(
    useShallow((s) => ({
      threads: s.threads,
      threadsLoading: s.isLoadingThreads,
      replyToMessage: s.replyToMessage?.threadId === threadId ? s.replyToMessage : null,
    })),
  );
  const queue = useChatStore((s) => s.getThreadState(threadId).queue);
  const flaggedDrafts = useChatStore(
    useShallow((s) =>
      Object.fromEntries(
        [...new Set([...Object.keys(s.threadStates), s.currentThreadId])].map((id) => [
          id,
          !!s.getThreadState(id).hasDraft,
        ]),
      ),
    ),
  );
  // Either reading of the same fact marks a draft: the composer's flag (threads opened this page load) or the draft's
  // owner, thread-drafts, which survives a reload for threads not opened yet.
  const keptDrafts = useSyncExternalStore(
    subscribeDraftOwner,
    () =>
      store.threads
        .filter((t) => t.id !== threadId && hasPendingThreadDraft(t.id))
        .map((t) => t.id)
        .join('\u0000'),
    () => '',
  );
  const drafts = useMemo(
    () => ({
      ...(displayedSession.current === session ? flaggedDrafts : {}),
      ...Object.fromEntries(
        keptDrafts
          .split('\u0000')
          .filter(Boolean)
          .map((id) => [id, true]),
      ),
    }),
    [flaggedDrafts, keptDrafts, session],
  );
  const invocations = useChatStore((s) => s.getThreadState(threadId).catInvocations);
  const live = useChatStore(
    useShallow((s) =>
      Object.fromEntries(
        [...new Set([...Object.keys(s.threadStates), threadId])].map((id) => [id, s.getThreadState(id).catStatuses]),
      ),
    ),
  );
  const [pinnedProjects, setPinnedProjects] = useState<Set<string>>(() => new Set());
  const [projectNames, setProjectNames] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    setPinnedProjects(readPinnedProjects(localStorage));
    setProjectNames(readProjectNames(localStorage));
  }, []);
  const workspace = useWorkspace({
    loadRoots: need('project.workbench.workspace') || need('project.voice.worktrees'),
    loadContent: need('project.workbench.workspace.tree'),
    projectPath: store.threads.find((t) => t.id === threadId)?.projectPath ?? null,
  });
  const [contextQuery, setContextQuery] = useState('');
  const [contextFiles, setContextFiles] = useState<ContextFileHit[]>([]);
  const exportSnapshot = useRef<ChatData>();
  const exportReady = useRef<{ promise: Promise<void>; resolve: () => void }>();
  if (!exportReady.current) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    exportReady.current = { promise, resolve };
  }
  useEffect(() => {
    const controller = new AbortController();
    setContextFiles([]);
    if (!workspace.worktreeId || !contextQuery.trim()) return;
    const timer = window.setTimeout(async () => {
      const files = await searchWorkspaceContextFiles(workspace.worktreeId!, contextQuery.trim(), controller.signal);
      if (!controller.signal.aborted) setContextFiles(files);
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [workspace.worktreeId, contextQuery]);
  const executionsByKey = useActiveExecutionStore((s) => s.executionsByKey);
  const executions = useMemo(() => Object.values(executionsByKey), [executionsByKey]);
  const activeRuns = useMemo(
    () => Object.values(invocations).flatMap((info) => (info.activeRun ? [info.activeRun] : [])),
    [invocations],
  );
  useActiveExecutionProjection(threadId, socketConnected, need('chat.executions'));
  const pluginTargets = usePluginTargets(need('chat.pluginTargets'));
  // One draft per conversation, kept in browser storage (thread-drafts): read when it opens, written as it changes.
  const drafting = exportMids === undefined;
  const legacyDraft = useMemo(
    () => !!(drafting && session.ownerUserId && hasLegacyThreadDraft(threadId)),
    [drafting, session, threadId],
  );
  const inputChanged = useRef<() => void>();
  const serverDraft = useRef<ReturnType<typeof useServerComposerDraft>>();
  const leaving = useThreadDraftMarker(threadId, session);
  // IME composition is transient: keep it in the input state, but do not persist it as a draft.
  const composingRef = useRef(false);
  const [composing, setComposing] = useState(false);
  const draftRevision = useRef(0);
  const [images, setImages] = useState<File[]>(() => threadImageDrafts.get(threadId) ?? []);
  const [replyNotices, setReplyNotices] = useState<ChatData['replyNotices']>([]);
  const [sendingThreads, setSendingThreads] = useState<Record<string, true>>({});
  // Opening a conversation answers its new-reply notice.
  useEffect(() => {
    setReplyNotices((list) =>
      list.some((n) => n.threadId === threadId) ? list.filter((n) => n.threadId !== threadId) : list,
    );
  }, [threadId]);
  const [contexts, setContexts] = useState<ContextAttachment[]>(() =>
    drafting ? [...getContextAttachmentDraft(threadId)] : [],
  );
  const [preparingImages, setPreparingImages] = useState(false);
  const ui = useRef<ChatUiState>({
    draft: { 'chat-input': drafting ? getThreadDraft(threadId) : '' },
    target: '',
    navHidden: false,
    viewCat: null,
    reply: null,
    pop: null,
    find: { q: '', scope: 'thread', sort: 'time', active: false },
    group: 'recent',
    tag: null,
    speaking: null,
    multi: false,
    picked: {},
    execOpen: {},
    whisper: false,
    whisperTo: [],
    renaming: false,
    queueOpen: false,
    clock: Date.now(),
    f: {},
  });
  const writeInput = useCallback(
    (text: string) => {
      draftRevision.current += 1;
      ui.current.draft!['chat-input'] = text;
      if (!composingRef.current) leaving.hasCommittedText = !!text.trim();
      leaving.current = !!(
        leaving.hasCommittedText ||
        current.current.images.length ||
        current.current.contexts.length ||
        current.current.reply
      );
      inputChanged.current?.();
    },
    [leaving],
  );
  const setInput = useCallback(
    (value: React.SetStateAction<string>) => {
      writeInput(typeof value === 'function' ? value(ui.current.draft!['chat-input']) : value);
      if (window.clowderChat) window.clowderChat.emit('composer:changed', undefined);
    },
    [writeInput],
  );
  const [conversation, setConversation] = useState({ threadId, session });
  if (conversation.threadId !== threadId || conversation.session !== session) {
    const text = drafting ? getThreadDraft(threadId) : '';
    setConversation({ threadId, session });
    composingRef.current = false;
    setComposing(false);
    if (conversation.session !== session) setSendingThreads({});
    setImages(threadImageDrafts.get(threadId) ?? []);
    setContexts(drafting ? [...getContextAttachmentDraft(threadId)] : []);
    setContextQuery('');
    Object.assign(ui.current, {
      draft: { 'chat-input': text },
      target: '',
      viewCat: null,
      reply: null,
      pop: null,
      modal: null,
      multi: false,
      picked: {},
      execOpen: {},
      memberCard: null,
    });
  }
  // Picked images stay with their conversation for this session (the five most recent).
  useLayoutEffect(() => {
    if (apiSessionIdentity.getSnapshot() !== session) return;
    if (images.length) {
      threadImageDrafts.delete(threadId);
      threadImageDrafts.set(threadId, images);
      for (const oldest of [...threadImageDrafts.keys()].slice(0, -5)) threadImageDrafts.delete(oldest);
    } else threadImageDrafts.delete(threadId);
  }, [threadId, images, session]);
  const reply = displayedSession.current === session ? store.replyToMessage : null;
  useEffect(() => {
    if (!drafting || apiSessionIdentity.getSnapshot() !== session) return;
    syncContextAttachmentDraftToStorage(threadId, contexts);
    syncReplyDraftToStorage(threadId, reply);
  }, [drafting, threadId, contexts, reply, session]);
  // The same draft is kept on the server, so a refresh or another device continues it.
  const restoreDraft: Parameters<typeof useServerComposerDraft>[0]['restore'] = (saved, isCurrent) => {
    setInput(saved.text);
    setContexts(saved.contexts);
    const state = useChatStore.getState();
    if (saved.replyTo) {
      const message = state.messages.find((m) => m.id === saved.replyTo);
      state.setReplyTo({
        id: saved.replyTo,
        content: message?.content ?? '(原消息未加载)',
        senderCatId: message?.catId ?? null,
        threadId,
      });
    } else state.clearReplyTo();
    const previousUrls = new Set(images.flatMap((file) => draftFile.get(file)?.url ?? []));
    const savedUrls = new Set(saved.images.map((block) => block.url));
    return downloadImages(
      saved.images.map((block) => block.url),
      saved.images.filter((block) => block.type === 'file'),
    ).then((files) => {
      if (!isCurrent()) return;
      files.forEach((file, i) => draftFile.set(file, saved.images[i]));
      const fitFor = (all: File[]) => {
        const currentUrls = new Set(all.flatMap((file) => draftFile.get(file)?.url ?? []));
        const restored = files.filter(
          (_, i) => !previousUrls.has(saved.images[i].url) || currentUrls.has(saved.images[i].url),
        );
        const added = all.filter((file) => {
          const url = draftFile.get(file)?.url;
          return !url || (!previousUrls.has(url) && !savedUrls.has(url));
        });
        return fitRestoredComposerAttachments(restored, added);
      };
      const displayed = current.current.images;
      const fitted = fitFor(displayed);
      setImages((all) => (all === displayed ? fitted.files : fitFor(all).files));
      if (fitted.omitted) {
        useToastStore.getState().addToast({
          type: 'info',
          title: '输入框最多保留 5 个附件',
          message: `已保存的草稿附件已保留，${fitted.omitted} 个新选附件因上限未加入。`,
          duration: 6000,
        });
      }
    });
  };
  // Words, places and a quote handed to this conversation's input from elsewhere (a file, a work, a recall).
  const pendingInsert = useChatStore((s) => s.pendingChatInsert);
  useEffect(() => {
    if (pendingInsert?.threadId !== threadId) return;
    const state = useChatStore.getState();
    state.setPendingChatInsert(null);
    if (pendingInsert.text)
      setInput((previous) =>
        previous ? `${previous}${previous.endsWith('\n') ? '' : '\n'}${pendingInsert.text}` : pendingInsert.text,
      );
    if (pendingInsert.contextAttachments || pendingInsert.removeContextAttachmentIds)
      setContexts((all) =>
        applyContextAttachmentDelta(
          all,
          pendingInsert.contextAttachments ?? [],
          new Set(pendingInsert.removeContextAttachmentIds),
        ),
      );
    if (pendingInsert.replyToId) {
      const parent = state.messages.find((m) => m.id === pendingInsert.replyToId);
      state.setReplyTo({
        id: pendingInsert.replyToId,
        content: parent?.content ?? '(原消息未加载)',
        senderCatId: parent?.catId ?? null,
        threadId,
      });
    }
    const attachments = [
      ...new Set([
        ...(pendingInsert.imageUrls ?? []),
        ...(pendingInsert.preservedBlocks ?? []).flatMap((block) => (block.type === 'file' ? [block.url] : [])),
      ]),
    ];
    if (attachments.length) {
      setPreparingImages(true);
      downloadImages(attachments, pendingInsert.preservedBlocks)
        .then((files) => setImages((all) => [...all, ...files].slice(0, 5)))
        .catch((error: Error) =>
          useToastStore
            .getState()
            .addToast({ type: 'error', title: '图片未放回输入框', message: error.message, duration: 6000 }),
        )
        .finally(() => setPreparingImages(false));
    }
  }, [pendingInsert, threadId, setInput]);
  if (!composingRef.current) leaving.hasCommittedText = !!ui.current.draft!['chat-input'].trim();
  leaving.current = !!(leaving.hasCommittedText || images.length || contexts.length || store.replyToMessage);
  const [questions, setQuestions] = useState<Record<string, QuestionBinding>>({});
  const questionChanged = useCallback(
    (id: string, binding: QuestionBinding) =>
      setQuestions((previous) =>
        previous[id]?.record === binding.record &&
        previous[id]?.current === binding.current &&
        previous[id]?.failed === binding.failed
          ? previous
          : { ...previous, [id]: binding },
      ),
    [],
  );
  const [proposals, setProposals] = useState<Record<string, ProposalBinding>>({});
  const proposalChanged = useCallback((binding: ProposalBinding) => {
    const key = `${binding.target.mid}:${binding.target.blockId}`;
    setProposals((previous) =>
      previous[key]?.record === binding.record &&
      previous[key]?.current === binding.current &&
      previous[key]?.revision === binding.revision &&
      previous[key]?.recovery === binding.recovery
        ? previous
        : { ...previous, [key]: binding },
    );
  }, []);
  const proposalTargets = useMemo(
    () => messageCards(surfaceMessages, threadId, 'proposal').map((card) => card.target),
    [surfaceMessages, threadId],
  );
  const [schedules, setSchedules] = useState<Record<string, ScheduleBinding>>({});
  const memoryTargets = useMemo(
    () => messageCards(surfaceMessages, threadId, 'memory').map((card) => card.target),
    [surfaceMessages, threadId],
  );
  const [memoryProposals, setMemoryProposals] = useState<Record<string, MemoryMessageBinding>>({});
  const memoryProposalChanged = useCallback((binding: MemoryMessageBinding) => {
    const key = `${binding.target.mid}:${binding.target.block.id}`;
    setMemoryProposals((previous) =>
      previous[key]?.read === binding.read &&
      previous[key]?.current === binding.current &&
      previous[key]?.busy === binding.busy
        ? previous
        : { ...previous, [key]: binding },
    );
  }, []);
  const [cloudRecoveries, setCloudRecoveries] = useState<Record<string, CloudRecoveryBinding>>({});
  const recoveryTargets = useMemo(
    () => (exportMids === undefined ? cloudRecoveryTargets(surfaceMessages, threadId) : []),
    [surfaceMessages, threadId, exportMids],
  );
  const cloudChanged = useCallback((binding: CloudRecoveryBinding) => {
    setCloudRecoveries((previous) => {
      const old = previous[binding.target.mid];
      return old &&
        old.controller.loadState === binding.controller.loadState &&
        old.controller.phase === binding.controller.phase &&
        old.controller.operationError === binding.controller.operationError &&
        JSON.stringify(old.result) === JSON.stringify(binding.result) &&
        old.sourceAvailable === binding.sourceAvailable &&
        old.target.dispatchInvocationId === binding.target.dispatchInvocationId
        ? previous
        : { ...previous, [binding.target.mid]: binding };
    });
  }, []);
  const scheduleChanged = useCallback((binding: ScheduleBinding) => {
    const key = `${binding.mid}:${binding.blockId}`;
    setSchedules((previous) =>
      previous[key]?.proposal === binding.proposal &&
      previous[key]?.current === binding.current &&
      previous[key]?.blocked === binding.blocked &&
      previous[key]?.drifted === binding.drifted &&
      previous[key]?.error === binding.error &&
      previous[key]?.decide === binding.decide
        ? previous
        : { ...previous, [key]: binding },
    );
  }, []);
  const scheduleCards = useMemo(
    () =>
      messageCards(surfaceMessages, threadId, 'schedule').map((card) => ({ messageId: card.mid, block: card.block })),
    [surfaceMessages, threadId],
  );
  const cardWrites = useRef(new Set<string>());
  const runtimeAnswerContext = useRef<string | null>(null);
  const interactiveAttempts = useRef(new Map<string, { signature: string; operationId: string }>());
  const runtimeAttempts = useRef(new Map<string, { signature: string; operationId: string }>());
  const questionIds = useMemo(
    () => [...new Set(messageCards(surfaceMessages, threadId, 'ask').map((card) => card.interactionId))],
    [surfaceMessages, threadId],
  );
  useEffect(() => {
    if (exportMids === undefined || history.isLoadingHistory || catsLoading || !replyOutput.ready) return;
    const selection = selectMessagesForExport(history.messages, exportMids ?? []);
    if (history.hasMore && (exportMids === null || !selection.ready)) {
      void loadEarlier();
      return;
    }
    const ownersReady =
      memoryTargets.every((target) => memoryProposals[`${target.mid}:${target.block.id}`]?.current) &&
      questionIds.every((id) => questions[id]?.record && questions[id].current) &&
      scheduleCards.every((c) => schedules[`${c.messageId}:${c.block.id}`]?.current) &&
      proposalTargets.every(
        (t) => proposals[`${t.mid}:${t.blockId}`]?.record && proposals[`${t.mid}:${t.blockId}`].current,
      );
    if (selection.ready && ownersReady && !exportSnapshot.current) {
      exportSnapshot.current = current.current;
      exportReady.current!.resolve();
    }
  }, [
    exportMids,
    history.messages,
    history.isLoadingHistory,
    history.hasMore,
    catsLoading,
    replyOutput.ready,
    loadEarlier,
    questions,
    proposals,
    schedules,
    scheduleCards,
    questionIds,
    proposalTargets,
    memoryTargets,
    memoryProposals,
  ]);
  const project = useRef<ProjectBindings>();
  const [newProjectId, setNewProjectId] = useState<string>();
  const prospectivePreview = useRef<RoutingPreviewState>({ status: 'idle', targetCats: [], reason: null });
  const routingPreview = useRef<RoutingPreviewState>({ status: 'idle', targetCats: [], reason: null });
  const recoveryData = useMemo(
    () =>
      Object.fromEntries(
        recoveryTargets
          .filter((target) => cloudRecoveries[target.mid])
          .map((target) => [target.mid, cloudRecoveries[target.mid]]),
      ),
    [recoveryTargets, cloudRecoveries],
  );
  const contextSearch = useMemo(
    () => ({ query: contextQuery, files: contextFiles, worktreeId: workspace.worktreeId }),
    [contextQuery, contextFiles, workspace.worktreeId],
  );
  const voiceData = useMemo(
    () => ({
      state: voice.state,
      duration: voice.duration,
      text: voice.partialTranscript || voice.transcript,
      available: false,
    }),
    [voice.state, voice.duration, voice.partialTranscript, voice.transcript],
  );
  const data = useMemo<ChatData>(
    () => ({
      threadId,
      newProjectId,
      // A new conversation's routing comes from its admission binding, which reports after this render.
      get routingPreview() {
        return threadId === 'default' ? prospectivePreview.current : routingPreview.current;
      },
      threads: store.threads,
      threadsLoading: store.threadsLoading,
      messages: history.messages,
      drafts,
      legacyDraft,
      cats,
      me,
      get input() {
        return ui.current.draft!['chat-input'];
      },
      images,
      contexts,
      reply: store.replyToMessage,
      loading: history.isLoadingHistory,
      hasMore: history.hasMore,
      connected: socketConnected,
      forwardingBlocked: connection.forwardingBlocked,
      projectPins: pinnedProjects,
      projectNames,
      uploadStatus,
      uploadError,
      replyNotices,
      sending: !!sendingThreads[threadId],
      queue,
      executions,
      activeRuns,
      pluginTargets,
      preparingImages,
      historyEntries: inputHistory.entries,
      readonly: exportMids !== undefined || connection.isReadonly,
      updateRequired: connection.updateRequired,
      outputs: replyOutput.outputs,
      live,
      questions,
      proposals,
      schedules,
      fileUrl: (url) => resolveAssetUrl(url, API_URL) ?? '',
      memoryProposals,
      cloudRecoveries: recoveryData,
      contextSearch,
      search: search.response,
      voice: voiceData,
    }),
    [
      threadId,
      newProjectId,
      store.threads,
      store.threadsLoading,
      history.messages,
      drafts,
      legacyDraft,
      cats,
      me,
      images,
      contexts,
      store.replyToMessage,
      history.isLoadingHistory,
      history.hasMore,
      socketConnected,
      connection.forwardingBlocked,
      pinnedProjects,
      projectNames,
      uploadStatus,
      uploadError,
      replyNotices,
      sendingThreads,
      queue,
      executions,
      activeRuns,
      pluginTargets,
      preparingImages,
      inputHistory.entries,
      exportMids,
      connection.isReadonly,
      connection.updateRequired,
      replyOutput.outputs,
      live,
      questions,
      proposals,
      schedules,
      memoryProposals,
      recoveryData,
      contextQuery,
      contextFiles,
      workspace.worktreeId,
      search.response,
      voice.state,
      voice.duration,
      voice.partialTranscript,
      voice.transcript,
      voiceData,
      contextSearch,
    ],
  );
  const replyCurrent = useRef(replyOutput);
  replyCurrent.current = replyOutput;
  const current = useRef(data);
  current.current = data;
  // A send the server took clears the draft of the conversation it came from, wherever the owner is now.
  const clearSentDraft = (sent: string) => {
    if (sent === 'default') {
      homeDirtyRef.current = { title: false, pinned: false };
      ui.current.homeTitle = '';
      ui.current.homePin = false;
    }
    if (current.current.threadId === sent) {
      setInput('');
      setImages([]);
      setContexts([]);
      useChatStore.getState().clearReplyTo();
      return;
    }
    syncDraftToStorage(sent, '');
    threadImageDrafts.delete(sent);
    syncContextAttachmentDraftToStorage(sent, []);
    syncReplyDraftToStorage(sent, null);
  };
  const playback = useRef({ state: speech.state, messageId: speech.activeMessageId });
  playback.current = useMemo(
    () => ({ state: speech.state, messageId: speech.activeMessageId }),
    [speech.state, speech.activeMessageId],
  );
  const [engineMounted, setEngineMounted] = useState(false);
  useBrakeBindings(engineMounted);
  useConsoleCommandBindings(engineMounted);
  useEffect(() => {
    if (!engineMounted) return;
    const send = (items: ReturnType<typeof useToastStore.getState>['toasts']) => {
      for (const item of items) {
        if (item.reply && item.threadId) {
          // A finished reply elsewhere is a notice above the composer, not a popup with the whole reply.
          const notice = { threadId: item.threadId, ...item.reply, preview: item.message };
          if (notice.threadId !== current.current.threadId)
            setReplyNotices((list) => [notice, ...list.filter((n) => n.threadId !== notice.threadId)].slice(0, 5));
        } else window.clowderChat.emit('notification:toast', item);
        useToastStore.getState().removeToast(item.id);
      }
    };
    send(useToastStore.getState().toasts);
    return useToastStore.subscribe((state, previous) => {
      const previousIds = new Set(previous.toasts.map((item) => item.id));
      send(state.toasts.filter((item) => !previousIds.has(item.id)));
    });
  }, [engineMounted]);

  const forwardRetryRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const admissionRef = useRef<NewConversationAdmission | null>(null);
  const homeDirtyRef = useRef({ title: false, pinned: false });

  useLayoutEffect(() => {
    const state = useChatStore.getState(),
      kept = threadReplyDrafts.get(threadId);
    state.setCurrentThread(threadId);
    // Opening a conversation clears the quoted reply; its draft's reply comes back.
    if (displayedSession.current !== session) {
      displayedSession.current = session;
      state.clearReplyTo();
      for (const id of new Set([...Object.keys(state.threadStates), state.currentThreadId])) {
        if (state.getThreadState(id).hasDraft) state.setThreadHasDraft(id, false);
      }
    }
    if (drafting && kept) state.setReplyTo(kept);
  }, [drafting, threadId, session]);
  useEffect(() => {
    initSidebarWidth();
  }, []);

  useEffect(() => {
    if (voice.transcript && voice.state === 'idle') setInput((text) => text + (text ? ' ' : '') + voice.transcript);
  }, [voice.transcript, voice.state, setInput]);

  useEffect(() => {
    const target = pendingJump.current;
    if (target?.threadId !== threadId) return;
    if (target.catId) {
      ui.current.target = target.catId;
      delete target.catId;
      if (engineMounted) window.clowderChat.update();
    }
    if (!target.mid) {
      pendingJump.current = null;
      return;
    }
    // Judged on the opened thread's own history: right after a switch the hook's fields can still be the previous
    // thread's, and until its first page is read there is nothing to judge.
    const own = useChatStore.getState().getThreadState(threadId);
    if (own.isLoadingHistory || !own.messages.length) return;
    // The engine owns both history paging and arrival, so a user's scroll cancels the whole jump.
    pendingJump.current = null;
    ui.current.pendingMid = target.mid;
    ui.current.pendingBlock = target.block;
    if (engineMounted) window.clowderChat.update();
  }, [threadId, history.messages, history.isLoadingHistory, pendingJump, engineMounted]);

  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const changed = () => setDocumentVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const messageCount = history.messages.length;
  const deliveredCount = history.messages.filter((m) => m.deliveredAt !== undefined).length;
  const latestMessageId = history.messages.at(-1)?.id;
  useEffect(() => {
    if (exportMids !== undefined || !documentVisible || !engineMounted || !need('chat.messages')) return;
    let live = true;
    const generation = apiSessionIdentity.getSnapshot().generation;
    void request<{ caughtUp: boolean; advanced: boolean; handledMention: boolean }>(
      `/api/threads/${encodeURIComponent(threadId)}/read/latest`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    )
      .then((receipt) => {
        if (generation !== apiSessionIdentity.getSnapshot().generation) return;
        // The request can commit a read even when the conversation that sent it has since closed.
        if (!live && !receipt.advanced && !receipt.handledMention) return;
        notifyHandledMentionRead(receipt);
        const sidebarRow = useSidebarProjectionStore.getState().rows.find((row) => row.id === threadId);
        // A no-op receipt with no stale attention has nothing to reconcile.
        if (
          receipt.caughtUp &&
          receipt.advanced === false &&
          !receipt.handledMention &&
          !sidebarRow?.unreadCount &&
          !sidebarRow?.hasUserMention
        )
          return;
        return invalidateSidebarProjection();
      })
      .catch((error) => console.debug('[PDL read receipt]', error));
    return () => {
      live = false;
    };
  }, [
    threadId,
    messageCount,
    deliveredCount,
    latestMessageId,
    documentVisible,
    exportMids,
    engineMounted,
    need('chat.messages'),
  ]);

  const patchThread = async (
    id: string,
    patch: Record<string, unknown>,
    options: { refresh?: boolean } = {},
  ): Promise<Record<string, unknown>> => {
    const updated = await request<Record<string, unknown>>(`/api/threads/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (options.refresh !== false) await refreshSidebarThreadSnapshot();
    return updated;
  };
  const respondRuntime = async (
    mid: string,
    blockId: string,
    id: string,
    expected: RuntimeInteractionRecord,
    response: RuntimeInteractionResponse,
  ) => {
    if (cardWrites.current.has(id)) return;
    cardWrites.current.add(id);
    const signature = JSON.stringify(response);
    const previous = runtimeAttempts.current.get(id);
    const attempt = previous?.signature === signature ? previous : { signature, operationId: crypto.randomUUID() };
    runtimeAttempts.current.set(id, attempt);
    try {
      await submitRuntimeAnswers(
        id,
        { threadId, messageId: mid, blockId },
        {},
        { expected, operationId: attempt.operationId, response },
      );
      await questions[id].refresh();
    } finally {
      cardWrites.current.delete(id);
    }
  };
  const action: ChatPort['action'] = async (name, args, element) => {
    if (exportMids !== undefined) throw new Error('导出视图只读');
    if (name === 'processTalk') {
      if (!(await replyOutput.preference.save(args.v as 'whole' | 'record'))) throw new Error('过程段偏好未保存');
      return;
    }
    if (name === 'processTalkRead') {
      await replyOutput.preference.load();
      return;
    }
    const handled = await project.current?.action(name, args, element);
    if (handled && !['workReviewDiscuss', 'cafeWorkSrc'].includes(name)) return handled;
    const state = useChatStore.getState();
    const message = current.current.messages.find((m) => m.id === args.mid);
    switch (name) {
      case 'accountSave':
        return saveAccount(args.id, args.value);
      case 'capabilitySave':
        return saveCapability(args.value);
      case 'mcpRemove':
        return removeMcp(args.id, args.value);
      case 'mountRulesSave':
        return saveMountRules(args.value);
      case 'segmentSave':
        return saveInjectionSegment(args.id, args.value);
      case 'segmentReset':
        return resetInjectionSegment(args.id);
      case 'threadEffortSave':
        return saveThreadEffort(args.threadId, args.id, args.value);
      case 'threadSpeedSave':
        return saveThreadSpeed(args.threadId, args.id, args.value);
      case 'threadGoalSave':
        return saveThreadGoal(args.threadId, args.value);
      case 'pushClientRead':
        return readPushClient();
      case 'pushSubscribe':
        return subscribePush();
      case 'pushUnsubscribe':
        return unsubscribePush();
      case 'sessionImport':
        admissionRef.current!.updateTitle(args.title);
        admissionRef.current!.updatePinned(args.pinned === 'true');
        return admissionRef.current!.importSession(JSON.parse(args.value));
      case 'membersRead': {
        const meta = await readMemberSettings();
        return {
          ...meta,
          dshMembers: current.current.cats.filter((cat) => isDshMember(cat, meta.runtimes)).map((cat) => cat.id),
        };
      }
      case 'memberVoicesRead':
        return readVoiceChoices();
      case 'memberCanonRead':
        return readMemberCanon(args.id, threadId);
      case 'memberCanonSave':
        return saveMemberCanon(args.id, threadId, args.value, (element as unknown as File | null) ?? undefined);
      case 'nativeDetect':
        return readNativeMembers(args.journeyId, args.refresh === 'true');
      case 'nativePrepare':
        return prepareNativePartner(JSON.parse(args.value));
      case 'nativeCreate':
        return createNativeMember(JSON.parse(args.value), args.journeyId);
      case 'memberStrategySave':
        return saveMemberStrategy(args.id, JSON.parse(args.value));
      case 'memberPluginRead':
        return readMemberClientSettings(args.id);
      case 'memberRuntimeModels':
        return readMemberRuntimeModels(args.value);
      case 'memberPluginSave':
        return saveMemberClientSettings(
          JSON.parse(args.plugin),
          args.key,
          args.value,
          args.fixedClient ? JSON.parse(args.fixedClient) : undefined,
        );
      case 'memberDshRead':
      case 'memberDshCheck': {
        const cat = current.current.cats.find((cat) => cat.id === args.id);
        if (!cat || !isDshMember(cat, JSON.parse(args.value))) return null;
        try {
          const path = `/api/cats/${encodeURIComponent(cat.id)}/connection-check`;
          return name === 'memberDshRead'
            ? await request(path)
            : await write(
                path,
                {
                  attemptId: crypto.randomUUID(),
                  ...(args.expectedRevision ? { expectedRevision: args.expectedRevision } : {}),
                },
                'POST',
              );
        } catch {
          return { state: 'unknown', reasonCode: 'check_result_unknown' };
        }
      }
      case 'memberProviderSetup':
        return runMemberProviderSetup(args.op, args.value);
      case 'memberRefAudioUpload':
        return uploadRefAudioAsset((element as HTMLInputElement).files![0]);
      case 'memberTemplate':
        return pickMemberTemplate(args.id, JSON.parse(args.value), current.current.cats);
      case 'umOrder':
        return saveMemberOrder(args.keys as unknown as string[], current.current.cats);
      case 'memberDefault':
        await request('/api/config/default-cat', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ catId: args.id }),
        });
        await refreshCatsNow();
        return;
      case 'memberSave': {
        const baseline = args.id ? current.current.cats.find((cat) => cat.id === args.id) : null;
        if (args.id && !baseline) throw new Error('runtime.readError');
        return saveMember(
          JSON.parse(args.value),
          baseline ?? null,
          args.expectedRevision || undefined,
          args.shared ? JSON.parse(args.shared) : undefined,
          (update) => {
            window.clowderChat.emit('member:save', update);
          },
        );
      }
      case 'memberDelete':
        return removeMember(args.id, args.expectedRevision);
      case 'memberCloudRestore': {
        const { cat } = await write<{ cat: CatData }>(
          `/api/cats/${encodeURIComponent(args.id)}`,
          {
            restoreBuiltinCloudIdentity: true,
            expectedRevision: args.expectedRevision,
          },
          'PATCH',
        );
        await refreshCatsNow();
        return { ...cat, form: initialState(cat) };
      }
      case 'memberAvailable': {
        const member = current.current.cats.find((cat) => cat.id === args.id);
        if (!member) throw new Error('runtime.readError');
        return setMemberAvailable(member, args.v === 'true');
      }
      case 'ownerSave':
        return saveOwner(JSON.parse(args.value));
      case 'avatarUpload':
        return uploadAvatarAsset((element as HTMLInputElement).files![0]);
      case 'appearanceDeleteImage':
        return request(`/api/config/chat-background/images/${encodeURIComponent(args.id)}`, { method: 'DELETE' });
      case 'pluginArchive': {
        const file = (element as HTMLInputElement).files?.[0];
        if (!file) throw new Error('common.required');
        const form = new FormData();
        form.append('file', file);
        return request('/api/plugin-manager/plugins/install/upload', { method: 'POST', body: form });
      }
      case 'pluginOperation':
        return callPluginOperation(
          args.id,
          args.operation,
          args.action,
          JSON.parse(args.value),
          args.confirmed === 'true',
        );
      case 'pluginTest': {
        const result = await request<{ ok: boolean; message: string }>(
          `/api/plugins/${encodeURIComponent(args.id)}/test`,
          { method: 'POST' },
        );
        if (!result.ok) throw new Error(result.message);
        return result;
      }
      case 'cafeReadAll': {
        const receipt = await request('/api/threads/read/mark-all', { method: 'POST' });
        notifyHandledMentionRead(receipt);
        state.clearAllUnread();
        await invalidateSidebarProjection();
        return;
      }
      case 'threadBranch': {
        const result = await request<{ threadId: string }>(`/api/threads/${encodeURIComponent(threadId)}/branch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromMessageId: args.mid, editedContent: args.text, userId: getUserId() }),
        });
        await refreshSidebarThreadSnapshot();
        pushThreadRouteWithHistory(result.threadId, window);
        return;
      }
      case 'projectPin': {
        const next = new Set(pinnedProjects);
        if (args.v === 'true') next.add(args.id);
        else next.delete(args.id);
        writePinnedProjects(next, localStorage);
        setPinnedProjects(next);
        return;
      }
      case 'projectRename': {
        const next = new Map(projectNames);
        if (args.v === projectDisplayName(args.id)) next.delete(args.id);
        else next.set(args.id, args.v);
        writeProjectNames(next, localStorage);
        setProjectNames(next);
        return;
      }
      case 'newProject':
        admissionRef.current!.updateProject(args.id || undefined);
        return;
      case 'homeTitle':
        ui.current.homeTitle = args.v ?? '';
        homeDirtyRef.current.title = true;
        admissionRef.current?.updateTitle(ui.current.homeTitle);
        return;
      case 'homePin':
        ui.current.homePin = args.pinned === 'true';
        homeDirtyRef.current.pinned = true;
        admissionRef.current?.updatePinned(ui.current.homePin);
        return;
      case 'cafeLegacyDraftRecover': {
        const stillHere = () =>
          args.threadId === threadId &&
          current.current.threadId === threadId &&
          apiSessionIdentity.getSnapshot() === session;
        if (!stillHere() || !drafting || connection.isReadonly) return;
        const legacy = await readVerifiedLegacyThreadDraft(threadId, session).catch(() => undefined);
        if (!stillHere()) return;
        if (!legacy) {
          useToastStore.getState().addToast({
            type: 'info',
            title: '旧草稿仍保留在本机',
            message: '无法核验这份旧草稿的归属。请用原账号打开原会话。共享会话或归属不明的记录由本机维护者核实后处置。',
            duration: 8000,
          });
          return;
        }
        if (!(await window.clowderChat.confirm('legacyDraftRestore', {})) || !stillHere()) return;
        const host = current.current;
        if (
          composingRef.current ||
          host.input.trim() ||
          host.images.length ||
          host.contexts.length ||
          host.reply ||
          !serverDraft.current?.holdRecoveredDraft({
            text: legacy.text,
            images: [],
            contexts: legacy.contexts,
            replyTo: legacy.reply?.id,
          })
        ) {
          useToastStore.getState().addToast({
            type: 'info',
            title: '请先处理当前草稿',
            message: '当前草稿和旧记录均保留在本机。空输入框可以恢复旧稿。',
            duration: 6000,
          });
          return;
        }
        setInput(legacy.text);
        setContexts(legacy.contexts);
        if (legacy.reply) useChatStore.getState().setReplyTo(legacy.reply);
        return;
      }
      case 'compose': {
        const nextComposing = args.composing === '1';
        if (composingRef.current !== nextComposing) {
          composingRef.current = nextComposing;
          setComposing(nextComposing);
        }
        const pop = composerTrigger(args.v, Number(args.pos));
        if (pop || ui.current.pop?.typed) ui.current.pop = pop;
        if (pop?.kind === 'ctx') setContextQuery(pop.q!);
        writeInput(args.v);
        return;
      }
      case 'thread':
        ui.current.target = '';
        ui.current.reply = null;
        ui.current.pop = null;
        pushThreadRouteWithHistory(args.id, window);
        return;
      case 'send': {
        if (!session.ownerUserId || apiSessionIdentity.getSnapshot() !== session) return false;
        const input = ui.current.draft!['chat-input'];
        if (runtimeAnswerContext.current) {
          const id = runtimeAnswerContext.current,
            binding = questions[id];
          const expected = binding?.record;
          if (
            !binding?.current ||
            !expected?.cardRef ||
            expected.request.kind !== 'conversation_decision' ||
            !expected.request.allowTextResponse
          )
            throw new Error('请重新读取请求');
          if (images.length || contexts.length) throw new Error('此回答只接受文字');
          await respondRuntime(expected.cardRef.messageId, expected.cardRef.blockId, id, expected, {
            kind: 'text',
            text: input.trim(),
          });
          runtimeAnswerContext.current = null;
          setInput('');
          return;
        }
        if (connection.isReadonly) throw new Error('当前连接或页面版本不允许发送');
        const admission = admissionRef.current;
        if (threadId === 'default' && !admission?.ready) throw new Error('对话尚未就绪');
        // A message needs words or a context attachment; attachments alone are not one (the server refuses them).
        if (!input.trim() && !contexts.length) return;
        if (input.trim()) inputHistory.addEntry(input);
        const sentThread = threadId;
        if (sentThread === 'default' && admission) {
          if (homeDirtyRef.current.title && (admission.intent?.title ?? '') !== (ui.current.homeTitle ?? '')) {
            admission.updateTitle(ui.current.homeTitle ?? '');
          }
          if (homeDirtyRef.current.pinned && !!admission.intent?.pinned !== !!ui.current.homePin) {
            admission.updatePinned(!!ui.current.homePin);
          }
        }
        await sendHeldDraft({
          threadId: sentThread,
          owner: session.ownerUserId ?? undefined,
          signature: JSON.stringify([
            input.trim(),
            images.map((file) => [file.name, file.size, file.lastModified]),
            contexts,
            state.replyToMessage?.id ?? null,
            ui.current.target,
            ui.current.whisper ? ui.current.whisperTo : null,
          ]),
          keyed: sentThread !== 'default',
          send: (attemptKey) =>
            sentThread === 'default' && admission
              ? admission.send({
                  content: input.trim(),
                  images,
                  contextAttachments: contexts,
                  ...(ui.current.target ? { explicitTargetCats: [ui.current.target] } : {}),
                  ...(ui.current.whisper
                    ? { whisper: { visibility: 'whisper', whisperTo: ui.current.whisperTo } }
                    : {}),
                })
              : (serverDraft.current?.send(sentThread, async (composerDraftRevision, signal) => {
                  let revision: number | undefined;
                  const accepted = await handleSend(
                    input.trim(),
                    images.length ? images : undefined,
                    sentThread,
                    ui.current.whisper ? { visibility: 'whisper', whisperTo: ui.current.whisperTo } : undefined,
                    state.replyToMessage?.id,
                    contexts.length ? contexts : undefined,
                    ui.current.target ? [ui.current.target] : undefined,
                    {
                      idempotencyKey: attemptKey,
                      composerDraftRevision,
                      composerDraftConsumed: (value) => {
                        revision = value;
                      },
                      signal,
                    },
                  );
                  return accepted ? { revision } : false;
                }) ?? Promise.resolve(false)),
          hold: (on) => {
            if (apiSessionIdentity.getSnapshot() !== session) return;
            setSendingThreads((all) => {
              const next = { ...all };
              if (on) next[sentThread] = true;
              else delete next[sentThread];
              return next;
            });
          },
          clear: () => {
            if (apiSessionIdentity.getSnapshot() === session) clearSentDraft(sentThread);
          },
        });
        return;
      }
      case 'stop':
      case 'cafeRunStop': {
        const runs = current.current.executions.filter(
          (e) =>
            e.threadId === threadId &&
            (!args.id || e.catId === args.id) &&
            (!args.executionId || e.executionId === args.executionId) &&
            e.cancelability.state === 'cancelable',
        );
        await Promise.all(runs.map((run) => cancelProjectedExecution(run)));
        return;
      }
      case 'rename':
        await renameThreadTitleOptimistic(args.id || threadId, args.v, (id, title) =>
          patchThread(id, { title }, { refresh: false }),
        );
        return;
      case 'threadFeatureSave':
        await patchThread(args.id || threadId, { backlogItemId: args.value || null });
        return true;
      case 'preferredCats': {
        const admission = threadId === 'default' ? admissionRef.current : null;
        const selected =
          (admission
            ? admission.intent?.preferredCats
            : current.current.threads.find((t) => t.id === threadId)?.preferredCats) ?? [];
        const next = args.none
          ? []
          : selected.includes(args.id)
            ? selected.filter((id) => id !== args.id)
            : [...selected, args.id];
        if (admission) admission.updatePreferredCats(next);
        else await patchThread(threadId, { preferredCats: next });
        return;
      }
      case 'threadStatus': {
        const t = current.current.threads.find((t) => t.id === (args.id || threadId));
        const key = args.field === 'fav' ? 'favorited' : 'pinned';
        await patchThread(args.id || threadId, { [key]: args.v == null ? !t?.[key] : args.v === 'true' });
        return;
      }
      case 'threadDelete':
        try {
          await request(`/api/threads/${encodeURIComponent(args.id || threadId)}`, { method: 'DELETE' });
        } finally {
          invalidateThreadAttentionPreferences();
          await refreshSidebarThreadSnapshot();
        }
        if ((args.id || threadId) === threadId) pushThreadRouteWithHistory('default', window);
        return;
      case 'reply':
        ui.current.reply = args.mid || null;
        if (message)
          state.setReplyTo({ id: message.id, content: message.content, senderCatId: message.catId ?? null, threadId });
        else state.clearReplyTo();
        return;
      case 'cliSelection': {
        const source = current.current.messages.find((m) => m.id === args.mid)!;
        const leafSource = JSON.parse(args.source) as import('@cat-cafe/shared').CliOutputQuoteSource;
        ui.current.pop = cliQuoteSelection(source, element!, window.getSelection()!, leafSource);
        return;
      }
      case 'cliQuote': {
        const p = ui.current.pop!;
        setContexts(
          ContextAttachmentsSchema.parse([
            ...current.current.contexts,
            createQuoteContextAttachment(p.text!, p.source!, {
              selectionStart: p.selectionStart,
              selectionEnd: p.selectionEnd,
              comment: args.comment,
            }),
          ]),
        );
        ui.current.pop = null;
        return;
      }
      case 'messageSelection': {
        const source = current.current.messages.find((m) => m.id === args.mid)!;
        const selection = messageQuoteSelection(source, element!, window.getSelection()!);
        ui.current.pop = { kind: 'textsel', mid: source.id, text: selection.text, selection };
        return;
      }
      case 'cloudRecoveryRead':
        cloudRecoveries[args.mid]?.controller.refresh();
        return;
      case 'bindRetry':
        return cloudRecoveries[args.mid].controller.bindAndRetry(args.chatUrl);
      case 'messageQuote': {
        const selection = JSON.parse(args.selection) as MessageQuoteSelection;
        const source = current.current.messages.find((m) => m.id === selection.messageId);
        if (!source || source.extra?.recall) throw new Error('引用来源已变化');
        if (args.op === 'quote') {
          ui.current.reply = source.id;
          state.setReplyTo({ id: source.id, content: selection.text, senderCatId: source.catId ?? null, threadId });
        } else {
          const attachment = createQuoteContextAttachment(
            selection.text,
            { kind: 'message', threadId, messageId: source.id, ...(source.catId ? { senderCatId: source.catId } : {}) },
            { comment: args.comment, selectionStart: selection.selectionStart, selectionEnd: selection.selectionEnd },
          );
          setContexts(ContextAttachmentsSchema.parse([...current.current.contexts, attachment]));
        }
        ui.current.pop = null;
        return;
      }
      case 'older':
        return (await loadEarlier()) === true;
      case 'messageDelete':
        await request(`/api/messages/${encodeURIComponent(args.mid)}${args.v === 'false' ? '/restore' : ''}`, {
          method: args.v === 'false' ? 'PATCH' : 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: getUserId(), mode: 'soft' }),
        });
        await reconcileThreadWithServer(threadId, () => false, 'PdlMessageDelete');
        return;
      case 'replyNoticeDismiss':
        setReplyNotices((list) => list.filter((n) => n.threadId !== args.t));
        return;
      case 'runtimeReload':
        if (connection.updateRequired) {
          window.location.reload();
        }
        return;
      case 'refresh':
        if (args.k === 'runtime-interactions') {
          await Promise.all(Object.values(questions).map((q) => q.refresh()));
          return;
        }
        await reconcileThreadWithServer(threadId, () => false, 'PdlRefresh');
        return;
      case 'cafeExecOpen':
        ui.current.execOpen[args.mid] = !(ui.current.execOpen[args.mid] ?? ui.current.recordExpanded);
        return;
      case 'cafePick': {
        if (!message || message.extra?.recall) return;
        if (args.b === undefined) {
          if (ui.current.picked[message.id]) delete ui.current.picked[message.id];
          else ui.current.picked[message.id] = wholeSelection(message);
        } else {
          if (!message.extra?.rich?.blocks.some((b) => b.id === args.b)) throw new Error('富块已变化');
          const selection = ui.current.picked[message.id] ?? { text: false, blocks: {} };
          if (selection.blocks[args.b]) delete selection.blocks[args.b];
          else selection.blocks[args.b] = true;
          if (selection.text || Object.keys(selection.blocks).length) ui.current.picked[message.id] = selection;
          else delete ui.current.picked[message.id];
        }
        return;
      }
      case 'cafeWhisper':
        if (args.v === 'off') ui.current.whisper = false;
        else if (args.id)
          ui.current.whisperTo = ui.current.whisperTo.includes(args.id)
            ? ui.current.whisperTo.filter((id) => id !== args.id)
            : [...ui.current.whisperTo, args.id];
        return;
      case 'contextSearch':
        setContextQuery(args.q);
        return;
      case 'cafeTypedPick': {
        if (args.kind === 'work') {
          const response = await request<{ artifact: import('@cat-cafe/shared').ThreadArtifactDTO }>(
            `/api/works/resolve-file?${new URLSearchParams({ threadId, contentRef: args.id, ownerRevision: args.path })}`,
          );
          const work = response.artifact;
          setContexts(
            ContextAttachmentsSchema.parse([
              ...current.current.contexts,
              {
                v: 1,
                id: crypto.randomUUID(),
                kind: 'work',
                workId: args.id,
                version: work.work!.ownerRevision,
                title: work.name,
              },
            ]),
          );
          ui.current.pop = null;
          return;
        }
        if (args.kind === 'file' && workspace.worktreeId) {
          setContexts((all) => [...all, createFileContextAttachment(args.path, workspace.worktreeId)]);
          ui.current.pop = null;
          return;
        }
        const thread = current.current.threads.find((t) => t.id === args.id);
        if (thread) setContexts((all) => [...all, createThreadContextAttachment(thread)]);
        ui.current.pop = null;
        return;
      }
      case 'removeContext':
        setContexts((all) => all.filter((_, i) => i !== Number(args.id)));
        return;
      case 'removeImage':
        setImages((all) => all.filter((_, i) => i !== Number(args.id)));
        return;
      case 'cafeQueueSend': {
        const entry = current.current.queue.find((q) => q.id === args.id)!;
        await request(
          `/api/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(entry.id)}/${args.mode === 'cut' ? 'steer' : 'continue'}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetCatId: entry.targetCats[0] }),
          },
        );
        await reconcileThreadWithServer(threadId, () => false, 'PdlQueue');
        return;
      }
      case 'cafeQueue': {
        const entry = current.current.queue.find((q) => q.id === args.id);
        if (args.v === 'remove')
          await request(`/api/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(args.id)}`, {
            method: 'DELETE',
          });
        else if (args.v === 'recall' && entry?.messageId) {
          const { input: text, images: kept, contexts: places, reply } = current.current;
          const drafted = text.trim() || kept.length || places.length || reply;
          if (drafted && !(await window.clowderChat.confirm('queueRecallAppend', {}))) return;
          const recalled = await requestTrueRecall({ threadId, messageId: entry.messageId });
          if (recalled) {
            state.setQueue(threadId, recalled.queue);
            const insert = composerInsertFromRecall(recalled);
            if (insert) state.setPendingChatInsert(insert);
          }
        }
        await reconcileThreadWithServer(threadId, () => false, 'PdlQueue');
        return;
      }
      case 'forward': {
        if (connection.forwardingBlocked) throw new Error('当前连接或页面版本不允许转发');
        const targetCats = JSON.parse(args.cats) as string[];
        const messageIds = JSON.parse(args.mids) as string[];
        if (!targetCats.length || !messageIds.length) throw new Error('请选择消息与接收成员');
        const payload = {
          sourceThreadId: threadId,
          targetThreadId: args.to,
          targetCats,
          items:
            ui.current.modal?.selectionItems ??
            (args.partial === 'true'
              ? selectedItems(
                  current.current.messages.filter((m) => messageIds.includes(m.id)),
                  ui.current.picked,
                )
              : messageIds.map((messageId) => ({ kind: 'message' as const, messageId }))),
        };
        const fingerprint = forwardPayloadFingerprint(payload);
        const key =
          forwardRetryRef.current?.fingerprint === fingerprint
            ? forwardRetryRef.current.key
            : createForwardIdempotencyKey();
        forwardRetryRef.current = { fingerprint, key };
        const messageBundleId = await submitMessageBundleForward(payload, key);
        forwardRetryRef.current = null;
        return messageBundleId;
      }
      case 'cafeFind':
        await search.search(
          ui.current.find.q,
          ui.current.find.scope === 'all' ? 'global' : 'thread',
          ui.current.find.sort === 'rel' ? 'relevance' : 'time',
        );
        return;
      case 'entityResolve': {
        const binding = Object.values(memoryProposals).find((p) => p.target.mid === args.mid)!;
        try {
          await resolveMemoryEntity(binding, {
            fingerprint: args.fingerprint,
            action: args.action,
            ...(args.replacementCanonicalNames
              ? { replacementCanonicalNames: JSON.parse(args.replacementCanonicalNames) }
              : {}),
          });
          delete ui.current.f['entity-error-' + args.mid];
        } catch (error) {
          ui.current.f['entity-error-' + args.mid] = error instanceof Error ? error.message : String(error);
        }
        return;
      }
      case 'cardAskToggle':
        ui.current.asking ??= {};
        ui.current.asking[args.mid] = !ui.current.asking[args.mid];
        return;
      case 'proposalReadback': {
        const binding = Object.values(proposals).find((p) => p.target.mid === args.mid);
        if (binding) await recheckProposal(binding);
        return;
      }
      case 'cardDecide':
      case 'cardAsk': {
        if (connection.isReadonly) throw new Error('当前连接或页面版本不允许提交');
        const memory = Object.values(memoryProposals).find((binding) => binding.target.mid === args.mid);
        if (memory && name === 'cardDecide') return decideMemoryMessage(memory, args.v === 'no' ? 'reject' : 'approve');
        const schedule = Object.values(schedules).find((s) => s.mid === args.mid);
        if (schedule && name === 'cardDecide') {
          if (schedule.blocked || !schedule.current) throw new Error('请重新读取提议');
          await schedule.decide(args.v === 'no' ? 'reject' : 'approve');
          return;
        }
        const binding = Object.values(proposals).find((p) => p.target.mid === args.mid);
        if (!binding?.record || !binding.current) throw new Error('请重新读取提议');
        ui.current.editing ??= {};
        if (args.v === 'edit' || args.v === 'editCancel') {
          ui.current.editing[args.mid] = args.v === 'edit';
          return;
        }
        if (cardWrites.current.has(args.mid)) return;
        cardWrites.current.add(args.mid);
        try {
          if (name === 'cardAsk') {
            await requestProposalRevision(
              binding,
              String(ui.current.f[`proposal-ask-${encodeURIComponent(binding.target.id)}`] ?? args.v ?? ''),
              (catId, text) => handleSend(text, undefined, threadId, undefined, undefined, undefined, [catId]),
            );
            ui.current.asking![args.mid] = false;
          } else {
            const card = proposalView(
              binding,
              !!ui.current.editing[args.mid],
              !!ui.current.asking?.[args.mid],
              ui.current.f,
            );
            const rows = card && 'editRows' in card ? card.editRows : [];
            const edits = ui.current.editing[args.mid]
              ? Object.fromEntries(rows.map((r) => [r.key, String(r.value)]))
              : undefined;
            await decideProposal(binding, args.v === 'no' ? 'reject' : 'approve', edits);
          }
          ui.current.editing[args.mid] = false;
        } finally {
          cardWrites.current.delete(args.mid);
        }
        return;
      }
      case 'runtimePick': {
        const record = questions[args.id]?.record;
        if (!record || record.status !== 'pending' || record.request.kind !== 'conversation_decision') return;
        const block = record.request.presentation;
        if (!block.options.some((o) => o.id === args.v)) throw new Error('请选择有效选项');
        const key = runtimeFieldKey(args.id, 'selected');
        const selected = (ui.current.f[key] ?? []) as string[];
        ui.current.f[key] =
          block.interactiveType !== 'multi-select'
            ? [args.v]
            : selected.includes(args.v)
              ? selected.filter((v) => v !== args.v)
              : block.maxSelect && selected.length >= block.maxSelect
                ? selected
                : [...selected, args.v];
        return;
      }
      case 'runtimeCustom':
        ui.current.f[runtimeFieldKey(args.id, 'custom')] = args.v;
        return;
      case 'runtimeConversationInsert': {
        const binding = questions[args.id];
        if (
          !binding?.current ||
          binding.record?.request.kind !== 'conversation_decision' ||
          !binding.record.request.allowTextResponse ||
          binding.record.status !== 'pending'
        )
          throw new Error('请求不可回答');
        runtimeAnswerContext.current = args.id;
        setInput(binding.record.request.title);
        return;
      }
      case 'runtimeRespond': {
        if (connection.isReadonly) throw new Error('当前连接或页面版本不允许提交');
        const source = args.mid
          ? current.current.messages.find((m) => m.id === args.mid)
          : current.current.messages.find((m) => m.extra?.runtimeInteractionCard?.interactionId === args.id);
        const card = source?.extra?.runtimeInteractionCard;
        if (!card || !questions[card.interactionId]?.current) throw new Error('请重新读取请求');
        const expected = questions[card.interactionId].record;
        if (!expected) throw new Error('请重新读取请求');
        const response = runtimeResponse(
          expected,
          source.id,
          ui.current.f,
          args.decisionId,
          args.p,
          ui.current.runtime?.drafts[expected.request.interactionId]?.values,
        );
        await respondRuntime(source.id, card.blockId, card.interactionId, expected, response);
        return;
      }
      case 'cafeWorkSrc': {
        const source = handled as {
          threadId: string;
          mid: string;
          catId?: string;
          insert?: import('@/stores/chat-types').ComposerDraftInsert;
        };
        if (source.insert) state.setPendingChatInsert(source.insert);
        if (source.threadId !== threadId) {
          pendingJump.current = { threadId: source.threadId, mid: source.mid, catId: source.catId };
          pushThreadRouteWithHistory(source.threadId, window);
        } else {
          if (source.catId) ui.current.target = source.catId;
          if (source.mid) await action('jump', { mid: source.mid });
        }
        return true;
      }
      case 'workFileQuote': {
        const attachment = (await project.current!.action('documentQuoteResolve', args)) as ContextAttachment;
        const next = ContextAttachmentsSchema.parse([...current.current.contexts, attachment]);
        setContexts(next);
        ui.current.pop = null;
        return;
      }
      case 'mediaSelectionSave': {
        const selection = (await project.current!.action('workSelectionPrepare', args)) as {
          target: MediaChatTarget;
          anchor: ArtifactReviewAnchor;
          words: string;
        };
        const result = addMediaSelection(current.current.contexts, selection.target, selection.anchor, selection.words);
        if (result.kind === 'refused') throw new Error(MEDIA_SELECTION_REFUSAL_COPY[result.reason]);
        setContexts((all) => [...all.filter((a) => a.id !== result.attachment.id), result.attachment]);
        if (ui.current.lb) {
          ui.current.lb.selection = null;
          ui.current.lb.words = '';
        }
        ui.current.pop = null;
        return;
      }
      case 'workReviewDiscuss': {
        const discussion = handled as {
          threadId: string;
          target: string;
          attachment: Omit<Extract<ContextAttachment, { kind: 'media' }>, 'id'>;
        } | null;
        if (!discussion || discussion.threadId !== threadId) throw new Error('请回到作品所属对话继续讨论');
        const result = addMediaWork(current.current.contexts, discussion.attachment);
        if (result.kind === 'refused') throw new Error(MEDIA_SELECTION_REFUSAL_COPY[result.reason]);
        setContexts((all) => [...all.filter((a) => a.id !== result.attachment.id), result.attachment]);
        ui.current.target = discussion.target;
        ui.current.lb = null;
        return;
      }
      case 'speak':
        if (!args.mid) speech.stop();
        else if (message && !message.extra?.recall) speech.synthesize(message.id, message.content, message.catId);
        return;
      case 'richPick':
      case 'richRandom': {
        const block = message?.extra?.rich?.blocks.find((b) => b.id === args.b);
        if (
          !message ||
          !block ||
          block.kind !== 'interactive' ||
          block.disabled ||
          message.extra?.runtimeInteractionCard?.blockId === block.id
        )
          throw new Error('交互来源不可用');
        const value =
          name === 'richRandom'
            ? block.allowRandom
              ? block.options[Math.floor(Math.random() * block.options.length)]?.id
              : undefined
            : args.v;
        if (!value || !block.options.some((o) => o.id === value)) throw new Error('请选择有效选项');
        const key = `pick:${message.id}:${block.id}`;
        const selected = (ui.current.f[key] ?? []) as string[];
        ui.current.f[key] =
          block.interactiveType !== 'multi-select'
            ? [value]
            : selected.includes(value)
              ? selected.filter((v) => v !== value)
              : block.maxSelect && selected.length >= block.maxSelect
                ? selected
                : [...selected, value];
        return;
      }
      case 'richSubmit': {
        if (connection.isReadonly || !message?.catId) throw new Error('当前不能提交');
        const block = message.extra?.rich?.blocks.find((b) => b.id === args.b);
        if (!block || block.kind !== 'interactive' || message.extra?.runtimeInteractionCard?.blockId === block.id)
          throw new Error('交互来源不匹配');
        const group = block.groupId
          ? message.extra!.rich!.blocks.filter(
              (b): b is typeof block => b.kind === 'interactive' && b.groupId === block.groupId,
            )
          : [block];
        const key = `${message.id}:${block.groupId ?? block.id}`;
        if (cardWrites.current.has(key)) return;
        cardWrites.current.add(key);
        try {
          const picks = group.map((b) => ({
            block: b,
            selectedIds: (ui.current.f[`pick:${message.id}:${b.id}`] ?? []) as string[],
            customInput: String(ui.current.f[`pick-${message.id}:${b.id}-t`] ?? '').trim(),
          }));
          const signature = JSON.stringify(picks);
          const previous = interactiveAttempts.current.get(key);
          const attempt =
            previous?.signature === signature ? previous : { signature, operationId: crypto.randomUUID() };
          interactiveAttempts.current.set(key, attempt);
          const saved = await submitInteractiveGroup(
            message.id,
            picks,
            (text) =>
              handleSend(text, undefined, threadId, undefined, message.id, undefined, [message.catId!], {
                idempotencyKey: attempt.operationId,
              }),
            (patches) => {
              const owner = useChatStore.getState();
              owner.replaceThreadMessages(
                threadId,
                owner.getThreadState(threadId).messages.map((row) =>
                  row.id !== message.id || !row.extra?.rich
                    ? row
                    : {
                        ...row,
                        extra: {
                          ...row.extra,
                          rich: {
                            ...row.extra.rich,
                            blocks: row.extra.rich.blocks.map((b) => {
                              const patch = patches.find((p) => p.blockId === b.id);
                              return patch ? { ...b, disabled: patch.disabled, selectedIds: patch.selectedIds } : b;
                            }),
                          },
                        },
                      },
                ),
              );
            },
          );
          for (const b of group) {
            delete ui.current.f[`pick:${message.id}:${b.id}`];
            delete ui.current.f[`pick-${message.id}:${b.id}-t`];
          }
          if (!saved)
            useToastStore.getState().addToast({ type: 'error', title: args.saveFailed, message: '', duration: 8000 });
        } finally {
          cardWrites.current.delete(key);
          await reconcileThreadWithServer(threadId, () => false, 'PdlInteractive');
        }
        return;
      }
      case 'cafeMic':
        if (voice.state === 'recording') voice.stopRecording();
        else await voice.startRecording();
        return;
      case 'executionLocate': {
        const execution = Object.values(useActiveExecutionStore.getState().executionsByKey).find(
          (e) => e.executionId === args.k && e.threadId === args.thread && e.catId === args.who,
        );
        if (
          !execution ||
          execution.startedAt !== Number(args.startedAt) ||
          (execution.turnInvocationId ?? '') !== (args.inv ?? '')
        )
          return 'unavailable';
        if (execution.kind === 'managed_command') return 'command';
        if (!execution.turnInvocationId) return 'unavailable';
        const expected = execution.inputCapabilities?.append?.expectedRun;
        if (expected && (expected.invocationId !== execution.turnInvocationId || expected.targetId !== execution.catId))
          return 'unavailable';
        const message = state
          .getThreadState(execution.threadId)
          .messages.find(
            (m) =>
              m.catId === execution.catId &&
              (expected
                ? m.id === expected.responseMessageId
                : m.lifecycle?.kind === 'response'
                  ? m.lifecycle.invocationId === execution.turnInvocationId
                  : m.isStreaming &&
                    (m.extra?.stream?.turnInvocationId ?? m.extra?.stream?.invocationId) ===
                      execution.turnInvocationId),
          );
        const mid = expected?.responseMessageId ?? message?.id;
        if (!mid) return 'unavailable';
        ui.current.execOpen[mid] = true;
        await action('jump', { thread: execution.threadId, mid });
        return 'opened';
      }
      case 'jump': {
        if (args.thread && args.thread !== threadId) {
          pendingJump.current = { threadId: args.thread, mid: args.mid, ...(args.block ? { block: args.block } : {}) };
          pushThreadRouteWithHistory(args.thread, window);
          return;
        }
        ui.current.pendingMid = args.mid;
        ui.current.pendingBlock = args.block;
        return;
      }
      case 'themePackExport':
      case 'themeCustomExport': {
        const response =
          name === 'themePackExport'
            ? await apiFetch(`/api/console-themes/packages/${encodeURIComponent(String(args.id))}/export`)
            : await apiFetch('/api/console-themes/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ theme: args.theme }),
              });
        if (!response.ok) throw new Error((await response.json()).error || '导出失败');
        const theme = args.theme as { name?: string } | undefined;
        return downloadPayload(
          response,
          `${name === 'themePackExport' ? String(args.id) : String(theme?.name ?? 'theme').replace(/\s+/g, '-')}.theme.zip`,
        );
      }
      case 'cafeExport':
      case 'cafeMultiExport': {
        const format =
          args.v === 'png' || args.v === '长图' ? 'png' : args.v === 'txt' || args.v === '文本' ? 'txt' : 'md';
        const selected = name === 'cafeMultiExport';
        const items = selected ? selectedItems(current.current.messages, ui.current.picked) : [];
        const path = selected
          ? format === 'png'
            ? `/api/threads/${encodeURIComponent(threadId)}/export-selection-image`
            : `/api/export/thread/${encodeURIComponent(threadId)}/selection`
          : format === 'png'
            ? `/api/threads/${encodeURIComponent(threadId)}/export-image`
            : `/api/export/thread/${encodeURIComponent(threadId)}?format=${format}`;
        const response = await apiFetch(
          path,
          selected
            ? {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ format, items }),
              }
            : format === 'png'
              ? { method: 'POST' }
              : undefined,
        );
        if (!response.ok) throw new Error((await response.json()).error || '导出失败');
        return downloadPayload(response, `${selected ? 'selection' : 'thread'}-${threadId}.${format}`);
      }
      case 'attach':
        if (element instanceof HTMLInputElement) setImages((all) => [...all, ...Array.from(element.files ?? [])]);
        return;
    }
  };
  const actionRef = useRef(action);
  actionRef.current = action;
  const dataPublisher = useRef<() => void>(() => {});
  const sidebarSnapshot = (): SidebarSnapshot => ({
    ...(project.current?.sidebarData ?? {
      owner: null,
      classification: { phase: 'idle', error: '', newLabels: [], suggestions: [] },
      attention: [],
    }),
    threads: current.current.threads,
    load: current.current.threadsLoading ? 'loading' : '',
    threadId: current.current.threadId,
    executions: current.current.executions,
    projectPins: [...(current.current.projectPins ?? [])],
    projectNames: [...(current.current.projectNames ?? [])],
    timeZone: current.current.me.timeZone,
  });
  const lastInput = useRef<{ source: ChatData; chat: Record<string, unknown> }>();
  const inputSnapshot = (): ChatPort['data'] => {
    const source = exportSnapshot.current ?? current.current;
    if (lastInput.current?.source !== source) {
      const previous = lastInput.current;
      const records = <T extends object>(
        key: keyof ChatData,
        values: Record<string, T> | undefined,
        adapt: (value: T) => unknown,
      ) => {
        const oldSource = previous?.source[key] as Record<string, T> | undefined;
        const oldRows = previous?.chat[key] as Record<string, unknown> | undefined;
        if (oldSource === values) return oldRows;
        return Object.fromEntries(
          Object.entries(values ?? {}).map(([id, value]) => [
            id,
            oldSource?.[id] === value ? oldRows![id] : adapt(value),
          ]),
        );
      };
      /* eslint-disable @typescript-eslint/no-unused-vars -- fields left out of the pushed chat data */
      const {
        threads: _threads,
        projectPins: _pins,
        projectNames: _names,
        fileUrl: _fileUrl,
        input: _input,
        questions,
        proposals,
        schedules,
        memoryProposals,
        cloudRecoveries,
        ...chat
      } = exportSnapshot.current ?? current.current;
      /* eslint-enable @typescript-eslint/no-unused-vars */
      const nextChat = {
        ...chat,
        // Commands remain on the host; unchanged records keep their raw data identity.
        /* eslint-disable @typescript-eslint/no-unused-vars -- host-only commands are excluded from data */
        questions: records('questions', questions, ({ refresh: _refresh, ...value }) => value),
        proposals: records('proposals', proposals, ({ refresh: _refresh, notify: _notify, ...value }) => value),
        schedules: records('schedules', schedules, ({ decide: _decide, ...value }) => value),
        memoryProposals: records('memoryProposals', memoryProposals, ({ refresh: _refresh, ...value }) => value),
        /* eslint-enable @typescript-eslint/no-unused-vars */
        cloudRecoveries: records('cloudRecoveries', cloudRecoveries, (value) => ({
          target: value.target,
          result: value.result,
          sourceAvailable: value.sourceAvailable,
          loadState: value.controller.loadState,
          phase: value.controller.phase,
          operationError: value.controller.operationError,
          attemptId: value.controller.attemptId,
        })),
      };
      lastInput.current = {
        source,
        chat:
          previous &&
          Object.keys(nextChat).every((key) => previous.chat[key] === nextChat[key as keyof typeof nextChat])
            ? previous.chat
            : nextChat,
      };
    }
    const preference = replyCurrent.current.preference;
    return {
      chat: lastInput.current.chat,
      project: project.current?.data,
      export: exportMids === undefined ? undefined : { mids: exportMids, items: window.__catCafeImageExportItems },
      playback: playback.current,
      outputPreference: { mode: preference.mode, status: preference.status, error: preference.error },
      admission: admissionRef.current && {
        ready: admissionRef.current.ready,
        optionsLocked: admissionRef.current.optionsLocked,
        preferredCats: admissionRef.current.intent?.preferredCats ?? [],
        title: admissionRef.current.intent?.title ?? '',
        pinned: !!admissionRef.current.intent?.pinned,
        homeState: { busy: admissionRef.current.optionsLocked, state: admissionRef.current.phase },
      },
    };
  };
  const port = useRef<ChatPort>(null!);
  if (!port.current)
    port.current = {
      get threadId() {
        return current.current.threadId;
      },
      exportMids,
      exportReady: exportMids === undefined ? Promise.resolve() : exportReady.current.promise,
      state: ui.current,
      needed: ({ added, removed }) =>
        setNeeded((previous) => {
          const next = new Set(previous);
          removed.forEach((source) => next.delete(source));
          added.forEach((source) => next.add(source));
          return next;
        }),
      data: inputSnapshot(),
      sidebarData: sidebarSnapshot(),
      action: async (...args) => {
        try {
          return await actionRef.current(...args);
        } finally {
          dataPublisher.current();
        }
      },
      richRender,
      terminal,
      get: (path, params, options) =>
        path === '/api/plugin-manager/pdl'
          ? readPluginSpaces()
          : path.startsWith('/api/plugin-manager/pdl/')
            ? readPluginSubtree(decodeURIComponent(path.slice('/api/plugin-manager/pdl/'.length)))
            : request(path + (params ? `?${new URLSearchParams(params)}` : ''), undefined, options),
      post: (path, params, body) => {
        const { method = 'POST', ...query } = params;
        return request(
          path + (Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''),
          {
            method,
            headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
            body: body instanceof FormData ? body : JSON.stringify(body),
          },
          mutationRequestOptions(path),
        );
      },
      file: (path) => resolveAssetUrl(path, API_URL) ?? '',
      attach: (files) => setImages((all) => [...all, ...files]),
      navResize: {
        min: 160,
        max: () => 400,
        width: () => useSidebarStore.getState().width,
        preview: (width) => useSidebarStore.getState().setWidth(width),
        commit: (width) => useSidebarStore.getState().setWidth(width),
        reset: () => useSidebarStore.getState().resetWidth(),
      },
    };
  const lastSidebar = useRef<{ source: ChatData }>();
  const publishData = useCallback(() => {
    const next = inputSnapshot(),
      sidebar = sidebarSnapshot();
    for (const key of ['playback', 'outputPreference', 'admission', 'export'] as const) {
      const old = port.current.data[key],
        value = next[key];
      if (
        old &&
        value &&
        Object.keys(value).every((field) =>
          Object.is((old as Record<string, unknown>)[field], (value as Record<string, unknown>)[field]),
        )
      )
        next[key] = old;
    }
    for (const key of ['projectPins', 'projectNames'] as const) {
      // These are projections of immutable sources; retain them with the source.
      if (lastSidebar.current?.source[key] === current.current[key])
        sidebar[key] = port.current.sidebarData[key] as never;
    }
    lastSidebar.current = { source: current.current };
    const sameInput = Object.keys(next).every((key) => next[key] === port.current.data[key]);
    const sameSidebar = Object.keys(sidebar).every(
      (key) => sidebar[key as keyof SidebarSnapshot] === port.current.sidebarData[key as keyof SidebarSnapshot],
    );
    if (sameInput && sameSidebar) return;
    if (!sameInput) port.current.data = next;
    if (!sameSidebar) port.current.sidebarData = sidebar;
    // The console accepts data during startup; the engine waits until boot to render.
    if (!window.clowderChat) return;
    window.clowderChat.update(port.current);
  }, []);
  dataPublisher.current = publishData;
  useEffect(() => {
    if (!engineMounted) return;
    const releaseSuggestions = hub.on('suggestion_updated', (value) =>
      window.clowderChat.emit('suggestion_updated', value),
    );
    const releaseIdentity = apiSessionIdentity.subscribe(() =>
      window.clowderChat.emit('session:changed', apiSessionIdentity.getSnapshot()),
    );
    const release = registerIndexEventHandler((event, data) => window.clowderChat.emit(event, data));
    const events = [
      'cat-cafe:socket-reconnected',
      'thread:teleport',
      'cat-cafe:entrusted-work-projection-invalidated',
      'cat-cafe:ignored-item-preferences-updated',
      'cat-cafe:collective-attention-invalidated',
      'cat-cafe:proposal-created',
      'cat-cafe:proposal-updated',
      'cat-cafe:runtime-interaction-updated',
      'cat-cafe:custody-offer-updated',
      'cat-cafe:user-mention-updated',
      'cat-cafe:plugin-operation-changed',
    ];
    const forward = (event: Event) => {
      if (event.type === 'cat-cafe:socket-reconnected') {
        setReadGeneration((generation) => generation + 1);
        window.clowderChat.emit('sources:needed', { added: [...neededNow.current], removed: [] });
      } else window.clowderChat.emit(event.type, (event as CustomEvent).detail);
    };
    events.forEach((event) => window.addEventListener(event, forward));
    return () => {
      release();
      releaseIdentity();
      releaseSuggestions();
      events.forEach((event) => window.removeEventListener(event, forward));
    };
  }, [engineMounted, hub, registerIndexEventHandler]);
  useLayoutEffect(publishData, [
    publishData,
    data,
    speech.state,
    speech.activeMessageId,
    replyOutput.preference.mode,
    replyOutput.preference.status,
    replyOutput.preference.error,
  ]);
  useEffect(() => {
    let active = true;
    void mountChat(port.current).then(() => {
      if (active) {
        window.clowderChat.update(port.current);
        setEngineMounted(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);
  const projectChanged = useCallback(
    (binding: ProjectBindings) => {
      project.current = binding;
      publishData();
    },
    [publishData],
  );
  const firstMessageChanged = useCallback(
    (admission: NewConversationAdmission, preview: RoutingPreviewState) => {
      admissionRef.current = admission;
      if (admission.intent && !admission.intent.creationStarted) {
        if (homeDirtyRef.current.title && (admission.intent.title ?? '') !== (ui.current.homeTitle ?? '')) {
          admission.updateTitle(ui.current.homeTitle ?? '');
        } else if (!homeDirtyRef.current.title) {
          ui.current.homeTitle = admission.intent.title ?? '';
        }
        if (homeDirtyRef.current.pinned && !!admission.intent.pinned !== !!ui.current.homePin) {
          admission.updatePinned(!!ui.current.homePin);
        } else if (!homeDirtyRef.current.pinned) {
          ui.current.homePin = !!admission.intent.pinned;
        }
      }
      setNewProjectId(admission.intent?.projectPath);
      prospectivePreview.current = preview;
      current.current = { ...current.current, newProjectId: admission.intent?.projectPath, routingPreview: preview };
      publishData();
    },
    [publishData],
  );
  const routingPreviewChanged = useCallback(
    (preview: RoutingPreviewState) => {
      routingPreview.current = preview;
      current.current = { ...current.current, routingPreview: preview };
      publishData();
    },
    [publishData],
  );
  return (
    <>
      <ComposerInputBinding
        threadId={threadId}
        enabled={drafting}
        ui={ui}
        inputChanged={inputChanged}
        serverDraft={serverDraft}
        composing={composing}
        draftRevision={draftRevision.current}
        session={session}
        images={images}
        contexts={contexts}
        reply={reply}
        restore={restoreDraft}
        refreshKey={JSON.stringify([
          history.messages.at(-1)?.id,
          store.threads.find((t) => t.id === threadId)?.preferredCats,
        ])}
        changed={routingPreviewChanged}
        firstMessage={threadId === 'default' && drafting && !!need('chat.input')}
        firstMessageChanged={firstMessageChanged}
      />
      {exportMids === undefined ? (
        <ProjectDataBinding
          data={data}
          needed={needed}
          readGeneration={readGeneration}
          workspace={workspace}
          fields={ui.current.f}
          ui={ui.current}
          target={() =>
            ui.current.target ||
            (current.current.routingPreview.status === 'ready' ? current.current.routingPreview.targetCats[0] : '') ||
            ''
          }
          changed={projectChanged}
        />
      ) : null}
      {need('chat.schedules')
        ? scheduleCards.map(({ messageId, block }) => (
            <ScheduleRecordBinding
              key={`${messageId}:${block.id}`}
              threadId={threadId}
              messageId={messageId}
              block={block}
              generation={readGeneration}
              changed={scheduleChanged}
            />
          ))
        : null}
      {need('chat.proposals')
        ? proposalTargets.map((target) => (
            <ProposalRecordBinding
              key={`${target.mid}:${target.blockId}`}
              target={target}
              generation={readGeneration}
              previous={proposals[`${target.mid}:${target.blockId}`]}
              changed={proposalChanged}
            />
          ))
        : null}
      {need('chat.memoryProposals')
        ? memoryTargets.map((target) => (
            <MemoryMessageOwnerBinding
              key={`${target.mid}:${target.block.id}`}
              target={target}
              generation={readGeneration}
              changed={memoryProposalChanged}
            />
          ))
        : null}
      {need('chat.cloudRecoveries')
        ? recoveryTargets.map((target) => (
            <CloudRecoveryOwnerBinding
              key={`${target.mid}:${target.dispatchInvocationId}`}
              target={target}
              messages={surfaceMessages}
              generation={readGeneration}
              previous={
                cloudRecoveries[target.mid]?.target.dispatchInvocationId === target.dispatchInvocationId
                  ? cloudRecoveries[target.mid]
                  : undefined
              }
              changed={cloudChanged}
            />
          ))
        : null}
      {need('chat.questions')
        ? questionIds.map((id) => (
            <RuntimeRecordBinding key={id} id={id} generation={readGeneration} changed={questionChanged} />
          ))
        : null}
    </>
  );
}

export function ComposerInputBinding({
  threadId,
  enabled,
  ui,
  inputChanged,
  serverDraft,
  composing = false,
  draftRevision = 0,
  session = apiSessionIdentity.getSnapshot(),
  images,
  contexts,
  reply,
  restore,
  refreshKey,
  changed,
  firstMessage,
  firstMessageChanged,
}: {
  threadId: string;
  enabled: boolean;
  ui: MutableRefObject<ChatUiState>;
  inputChanged: MutableRefObject<(() => void) | undefined>;
  serverDraft: MutableRefObject<ReturnType<typeof useServerComposerDraft> | undefined>;
  composing?: boolean;
  draftRevision?: number;
  session?: ApiSessionIdentity;
  images: File[];
  contexts: ContextAttachment[];
  reply: ChatData['reply'];
  restore: Parameters<typeof useServerComposerDraft>[0]['restore'];
  refreshKey: string;
  changed: (preview: RoutingPreviewState) => void;
  firstMessage: boolean;
  firstMessageChanged: (admission: NewConversationAdmission, preview: RoutingPreviewState) => void;
}) {
  const subscribe = useCallback(
    (notify: () => void) => {
      inputChanged.current = notify;
      return () => {
        inputChanged.current = undefined;
      };
    },
    [inputChanged],
  );
  const input = useSyncExternalStore(
    subscribe,
    () => ui.current.draft!['chat-input'],
    () => '',
  );
  useEffect(() => {
    // Uncommitted IME text is not a draft; the next committed edit writes the complete text.
    if (enabled && !composing && apiSessionIdentity.getSnapshot() === session) syncDraftToStorage(threadId, input);
  }, [enabled, threadId, input, composing, session]);
  const draft = useServerComposerDraft({
    threadId,
    enabled: enabled && threadId !== 'default',
    draft: {
      text: input,
      images: images.flatMap((file) => draftFile.get(file) ?? []),
      contexts,
      ...(reply ? { replyTo: reply.id } : {}),
    },
    restore,
    holdWrites: composing,
    revision: draftRevision,
  });
  useLayoutEffect(() => {
    serverDraft.current = draft;
  });
  const preview = useRoutingPreview({
    enabled: enabled && threadId !== 'default',
    content: input,
    scope: { scope: 'thread', threadId },
    refreshKey,
  });
  useLayoutEffect(() => {
    if (threadId !== 'default') changed(preview);
  }, [threadId, changed, preview]);
  return firstMessage ? <FirstMessageBinding content={input} onChange={firstMessageChanged} /> : null;
}

function CloudRecoveryOwnerBinding({
  target,
  messages,
  generation,
  previous,
  changed,
}: {
  target: CloudRecoveryTarget;
  generation: number;
  previous?: CloudRecoveryBinding;
  messages: ChatData['messages'];
  changed: (value: CloudRecoveryBinding) => void;
}) {
  const result = useCloudReply(
    {
      sourceMessageId: target.identity.sourceMessageId,
      targetCatId: target.identity.targetCatId,
      dispatchInvocationId: target.dispatchInvocationId,
    },
    target.identity.threadId,
    messages,
    { readGeneration: generation, initial: previous?.result },
  );
  const controller = useCloudBindingRecovery(target.identity, generation, previous?.controller);
  const source = messages.find((message) => message.id === target.identity.sourceMessageId);
  const sourceAvailable =
    !!source &&
    (target.bindOnly
      ? source.type === 'assistant' && source.from?.kind === 'agent' && source.from.catId === source.catId
      : source.type === 'user' && source.from?.kind === 'user' && source.from.userId === getUserId()) &&
    !source.extra?.recall &&
    source.visibility !== 'whisper';
  useLayoutEffect(() => {
    changed({ target, controller, result, sourceAvailable });
  });
  return null;
}

const openCreatedThread = (id: string) => pushThreadRouteWithHistory(id, window);

export const FirstMessageBinding = memo(function FirstMessageBinding({
  content,
  onChange,
}: {
  content: string;
  onChange: (admission: NewConversationAdmission, preview: RoutingPreviewState) => void;
}) {
  const admission = useNewConversationAdmission(openCreatedThread, confirmRouting);
  const preview = useRoutingPreview({
    enabled: admission.ready,
    content,
    scope: admission.intent ? { scope: 'new-thread', preferredCats: admission.intent.preferredCats } : null,
    suspended: admission.optionsLocked,
  });
  useLayoutEffect(() => {
    onChange(admission, preview);
  });
  return null;
});

function RuntimeRecordBinding({
  id,
  generation,
  changed,
}: {
  id: string;
  generation: number;
  changed: (id: string, binding: QuestionBinding) => void;
}) {
  const source = useApprovalResult(
    'F306',
    id,
    'runtime-record',
    (signal, fresh) => readRuntimeRecord(id, signal, fresh),
    undefined,
    false,
  );
  useEffect(() => {
    void source.refresh();
  }, [generation, source.refresh]);
  useLayoutEffect(() => {
    changed(id, {
      record: source.value,
      failed: source.failed,
      current: !source.failed && !source.stale && !source.reading,
      refresh: source.refresh,
    });
  }, [id, changed, source.value, source.failed, source.stale, source.reading, source.refresh]);
  return null;
}

export function ProposalRecordBinding({
  target,
  generation,
  previous,
  changed,
}: {
  target: ProposalTarget;
  generation: number;
  previous?: ProposalBinding;
  changed: (binding: ProposalBinding) => void;
}) {
  const source = useApprovalResult(
    target.feature,
    target.id,
    target.feature === 'F231' ? 'message-native' : 'native',
    (signal, fresh) =>
      target.feature === 'F231'
        ? readProposal(target, signal, fresh)
        : fetchApprovalProducerBody(
            {
              owner: apiSessionIdentity.getSnapshot().ownerUserId ?? '',
              producer: target.feature,
              proposalId: target.id,
            },
            proposalPath(target),
            signal,
          ),
    undefined,
    false,
  );
  const recoverySource = useApprovalResult<NonNullable<ProposalBinding['recovery']>>(
    target.feature,
    target.id,
    'pdl-decision',
    async () => ({ phase: '', reading: false }),
    undefined,
    false,
  );
  const [revision, notify] = useState(0);
  const recovery = useMemo<NonNullable<ProposalBinding['recovery']>>(
    () =>
      recoverySource.value ??
      (previous?.owner === source.ownerUserId && previous.recovery ? previous.recovery : { phase: '', reading: false }),
    [target.id, source.ownerUserId, recoverySource.value],
  );
  const binding = useRef<ProposalBinding | null>(null);
  useEffect(() => {
    void source.refresh();
  }, [generation, source.refresh]);
  const record = useMemo(() => {
    if (source.value === undefined) return undefined;
    try {
      return proposalFromBody(target, source.value);
    } catch {
      return null;
    }
  }, [target, source.value]);
  useLayoutEffect(() => {
    const value: ProposalBinding = {
      target,
      owner: source.ownerUserId,
      recovery,
      revision,
      notify: () => notify((n) => n + 1),
      record: record ?? undefined,
      current: record !== null && !source.failed && !source.stale && !source.reading,
      refresh: source.refresh,
    };
    binding.current = value;
    changed(value);
  }, [
    target,
    changed,
    record,
    source.failed,
    source.stale,
    source.reading,
    source.refresh,
    source.ownerUserId,
    recovery,
    revision,
  ]);
  useEffect(() => {
    const recover = () => {
      const current = binding.current;
      if (current && ['uncertain', 'placement'].includes(current.recovery?.phase ?? ''))
        void recheckProposal(current, false).catch(() => {});
    };
    const visible = () => {
      if (document.visibilityState === 'visible') recover();
    };
    for (const event of ['focus', 'online', 'cat-cafe:socket-reconnected']) window.addEventListener(event, recover);
    document.addEventListener('visibilitychange', visible);
    return () => {
      for (const event of ['focus', 'online', 'cat-cafe:socket-reconnected'])
        window.removeEventListener(event, recover);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return null;
}

function ScheduleRecordBinding({
  threadId,
  messageId,
  block,
  generation,
  changed,
}: {
  threadId: string;
  messageId: string;
  block: RichCardBlock;
  generation: number;
  changed: (binding: ScheduleBinding) => void;
}) {
  const [templates, setTemplates] = useState<NonNullable<ScheduleBinding['templates']>>([]);
  const [templateError, setTemplateError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void request<{ templates: NonNullable<ScheduleBinding['templates']> }>('/api/schedule/templates', {
      signal: abort.signal,
    }).then(
      (value) => {
        if (!abort.signal.aborted) {
          setTemplates(value.templates);
          setTemplateError(null);
        }
      },
      (error) => {
        if (!abort.signal.aborted) {
          setTemplates([]);
          setTemplateError(error.message);
        }
      },
    );
    return () => abort.abort();
  }, [generation]);
  const source = useScheduleApprovalController({
    block,
    messageId,
    coordinate: { threadId, messageId },
    readEnabled: false,
  });
  const reread = useRef(source.reread);
  reread.current = source.reread;
  useEffect(() => {
    if (!source.ownerUserId) {
      void readApprovalResultOwner();
      return;
    }
    reread.current();
  }, [generation, source.ownerUserId]);
  useLayoutEffect(() => {
    changed({
      mid: messageId,
      blockId: block.id,
      proposal: source.proposal,
      current: !source.checking && !source.unknown && !!source.proposal,
      blocked: source.blocked,
      drifted: source.drifted,
      error: source.error,
      templates,
      templateError,
      decide: source.decide,
    });
  }, [
    messageId,
    block.id,
    changed,
    source.proposal,
    source.checking,
    source.unknown,
    source.blocked,
    source.drifted,
    source.error,
    templates,
    templateError,
    source.decide,
  ]);
  return null;
}
