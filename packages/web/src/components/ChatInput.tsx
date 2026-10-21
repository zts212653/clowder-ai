'use client';

import {
  CONTEXT_ATTACHMENT_MAX_COUNT,
  type ContextAttachment,
  ContextAttachmentSchema,
  type MessageWorkDisposition,
} from '@cat-cafe/shared';
import { ComposerControl, ComposerFrame } from '@cat-cafe/ui';
import {
  type Dispatch,
  KeyboardEvent,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { GalleryDraftSummary } from '@/components/content-review/GalleryDraftSummary';
import { useCatData } from '@/hooks/useCatData';
import { type ProspectiveThreadRouting, useChatComposerRouting } from '@/hooks/useChatComposerRouting';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { useLiveExecutionCancelControl } from '@/hooks/useLiveExecutionCancelControl';
import { useMessageDispositionPreference } from '@/hooks/useMessageDispositionPreference';
import { usePathCompletion } from '@/hooks/usePathCompletion';
import type { UploadStatus, WhisperOptions } from '@/hooks/useSendMessage';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { formatCatDisplayName } from '@/lib/cat-display-name';
import { useChatStore } from '@/stores/chatStore';
import { useInputHistoryStore } from '@/stores/inputHistoryStore';
import { useToastStore } from '@/stores/toastStore';
import { compressImage } from '@/utils/compressImage';
import { AppTooltip } from './AppTooltip';
import { ChatComposerDraftExtras } from './ChatComposerDraftExtras';
import { ChatContextPicker } from './ChatContextPicker';
import { ChatInputActionButton } from './ChatInputActionButton';
import { ChatInputAddMenu } from './ChatInputAddMenu';
import { ChatInputMenus } from './ChatInputMenus';
import { ComposerRoutingPreview } from './ComposerRoutingPreview';
import { chatComposerCopy } from './chat-composer.shell-copy';
import { type ContextPickerMode, detectContextShortcut } from './chat-context-reference';
import { buildCatOptions, type CatOption, detectMenuTrigger } from './chat-input-options';
import {
  deriveImageLifecycleStatus,
  type ImageLifecycleStatus,
  isImageLifecycleBlockingSend,
} from './chat-input-upload-state';
import { composerAttachments } from './composer-queue';
import { HistorySearchModal } from './HistorySearchModal';
import { PathCompletionMenu } from './PathCompletionMenu';
import { projectScreeningComposerConflict } from './project-screening-composer-group';
import { conversationDecisionCopy } from './rich/conversation-decision.shell-copy';
import { submitConversationAnswer } from './rich/runtime-conversation-model';
import { useShellCopy } from './shell/shell-copy';
import {
  getThreadDraft,
  hasPendingThreadDraft,
  subscribeThreadDrafts,
  syncContextAttachmentDraftToStorage,
  syncDraftToStorage,
  syncReplyDraftToStorage,
  threadContextAttachmentDrafts,
  threadImageDrafts,
  threadReplyDrafts,
} from './thread-drafts';
import { useComposerKeyboardFocus } from './use-composer-keyboard-focus';
import { useDurableComposerDraft } from './useDurableComposerDraft';
import { useTextareaAutosize } from './useTextareaAutosize';
import { WhisperCatSelector } from './WhisperCatSelector';
import { useWorkspaceChatWorkScope } from './workbench/WorkspaceChatWorkScope';

/** Module-level draft storage — survives component unmount/remount across thread switches */
export {
  syncContextAttachmentDraftToStorage,
  syncDraftToStorage,
  syncReplyDraftToStorage,
  threadContextAttachmentDrafts,
  threadDrafts,
  threadImageDrafts,
  threadReplyDrafts,
} from './thread-drafts';

const MAX_IMAGE_DRAFT_THREADS = 5;
const NO_CONTEXT_ATTACHMENTS: ContextAttachment[] = [];
const COMPOSER_GRID_ROWS = ['row-start-1', 'row-start-2', 'row-start-3', 'row-start-4'] as const;
const subscribeNothing = () => () => {};
/** False while hydrating server HTML, true afterwards (and on any plain client mount). */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}

export interface ChatInputDraftSnapshot {
  text: string;
  files: File[];
  contextAttachments: ContextAttachment[];
}

interface ChatInputProps {
  /** The v2 host keeps the stop as the last control for an empty draft; classic retains a side stop. */
  presentation?: 'classic' | 'v2';
  /** Host-owned project control; only shown by the v2 composer. */
  composerContext?: ReactNode;
  /** Host-owned first row inside the v2 composer card. */
  composerHeader?: ReactNode;
  /** Not-yet-created thread state. Existing threads read and write preferredCats through their canonical ThreadStore route. */
  prospectiveThread?: ProspectiveThreadRouting;
  /** Thread ID for draft persistence — drafts are saved per-thread */
  threadId?: string;
  onSend: (
    content: string,
    images?: File[],
    whisper?: WhisperOptions,
    replyToId?: string,
    contextAttachments?: ContextAttachment[],
    explicitTargetCats?: string[],
    messageDisposition?: MessageWorkDisposition,
  ) => void | boolean | Promise<void | boolean>;
  disabled?: boolean;
  hasActiveInvocation?: boolean;
  uploadStatus?: UploadStatus;
  uploadError?: string | null;
  placeholder?: string;
  seed?: { id: string; text: string };
  onFocusChange?: (focused: boolean) => void;
  /** Optional host-owned persistence mirror (for the pre-thread landing owner). */
  onDraftChange?: (snapshot: ChatInputDraftSnapshot) => void;
}

const ACCEPTED_TYPES =
  'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/json,application/zip,application/gzip,application/x-tar,application/octet-stream,audio/mpeg,audio/wav,audio/ogg,video/mp4,video/webm';

function isComposerSendBlocked(imageStatus: ImageLifecycleStatus, unrestoredImageCount: number): boolean {
  return isImageLifecycleBlockingSend(imageStatus) || unrestoredImageCount > 0;
}

interface RecoveredAttachmentsNoticeProps {
  count: number;
  discardLabel: string;
  message: string;
  preparing: boolean;
  retryLabel: string;
  onDiscard: () => void;
  onRetry: () => void;
}

function RecoveredAttachmentsNotice({
  count,
  discardLabel,
  message,
  preparing,
  retryLabel,
  onDiscard,
  onRetry,
}: RecoveredAttachmentsNoticeProps) {
  if (count === 0) return null;
  return (
    <div
      className="mx-4 mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-conn-amber-ring bg-conn-amber-bg px-3 py-2 text-xs text-conn-amber-text"
      data-testid="composer-recovered-attachments-blocked"
      role="alert"
    >
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        className="shell-focusable rounded-md px-2 py-1 font-medium hover:bg-[var(--shell-selected)]"
        data-testid="composer-recovered-attachments-retry"
        disabled={preparing}
        onClick={onRetry}
      >
        {retryLabel}
      </button>
      <button
        type="button"
        className="shell-focusable rounded-md px-2 py-1 font-medium hover:bg-[var(--shell-selected)]"
        data-testid="composer-recovered-attachments-discard"
        disabled={preparing}
        onClick={onDiscard}
      >
        {discardLabel}
      </button>
    </div>
  );
}

export function ChatInput({
  presentation = 'classic',
  composerContext,
  composerHeader,
  prospectiveThread,
  threadId,
  onSend,
  disabled,
  hasActiveInvocation: unscopedHasActiveInvocation,
  uploadStatus = 'idle',
  uploadError = null,
  placeholder,
  seed,
  onFocusChange,
  onDraftChange,
}: ChatInputProps) {
  const v2Copy = useShellCopy(chatComposerCopy);
  const { cats } = useCatData();
  const ime = useIMEGuard();
  const [routingCompositionActive, setRoutingCompositionActive] = useState(false);
  const catOptions = useMemo(() => buildCatOptions(cats), [cats]);
  // F108 Scene 2: whisper-eligible cats (CatData[] for WhisperCatSelector)
  const whisperCats = useMemo(() => cats.filter((c) => c.roster?.available !== false), [cats]);

  // #699: Reply-to (quote) state — thread-scoped to prevent split-pane leaks
  const rawReplyToMessage = useChatStore((s) => s.replyToMessage);
  const setReplyToStore = useChatStore((s) => s.setReplyTo);
  const clearReplyTo = useChatStore((s) => s.clearReplyTo);
  // Only surface the reply when it belongs to this ChatInput's thread
  const replyToMessage = rawReplyToMessage?.threadId === threadId ? rawReplyToMessage : null;
  const replyHydrationThreadRef = useRef<string | null>(null);
  const replyPersistenceThreadRef = useRef<string | null>(null);

  // #934: Restore reply context from thread draft store before mount-time persistence.
  // ChatInput is keyed by threadId so this runs once per thread visit.
  useLayoutEffect(() => {
    if (!threadId || replyHydrationThreadRef.current === threadId) return;
    replyHydrationThreadRef.current = threadId;
    const savedReply = threadReplyDrafts.get(threadId);
    if (savedReply && rawReplyToMessage?.threadId !== threadId) {
      setReplyToStore(savedReply);
    }
  }, [threadId, rawReplyToMessage, setReplyToStore]);

  // F122B AC-B10: track which cats are actively executing (for whisper disable)
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const {
    hasActive: legacyHasActiveInvocation,
    activeInvocations,
    targetCats: storeTargetCats,
  } = useThreadLiveness(threadId ?? currentThreadId);
  const effectiveThreadId = threadId ?? currentThreadId;
  const legacyCancelTargets = useMemo(
    () =>
      Object.entries(activeInvocations).map(([executionId, invocation]) => ({ executionId, catId: invocation.catId })),
    [activeInvocations],
  );
  const {
    executions: canonicalExecutions,
    state: projectedCancelState,
    cancelAll: handleProjectedStop,
  } = useLiveExecutionCancelControl(effectiveThreadId, legacyCancelTargets);
  const effectiveLegacyActive = threadId
    ? legacyHasActiveInvocation
    : legacyHasActiveInvocation || unscopedHasActiveInvocation;
  const hasActiveInvocation = canonicalExecutions.length > 0 || effectiveLegacyActive;
  const stopState: 'available' | 'pending' | 'unavailable' | 'hidden' = hasActiveInvocation
    ? projectedCancelState
    : 'hidden';
  const shellV2 = presentation === 'v2';
  const workScope = useWorkspaceChatWorkScope();
  const activeCatIds = useMemo(() => {
    const ids = new Set<string>();
    for (const execution of canonicalExecutions) {
      ids.add(execution.catId);
    }
    if (ids.size === 0 && legacyHasActiveInvocation) {
      for (const inv of Object.values(activeInvocations ?? {})) ids.add(inv.catId);
      if (ids.size === 0 && storeTargetCats?.length) {
        for (const catId of storeTargetCats) ids.add(catId);
      }
    }
    return ids;
  }, [activeInvocations, canonicalExecutions, legacyHasActiveInvocation, storeTargetCats]);

  const [unscopedInput, setUnscopedInput] = useState('');
  const scopedInput = useSyncExternalStore(
    subscribeThreadDrafts,
    () => getThreadDraft(threadId),
    () => '',
  );
  const input = threadId ? scopedInput : unscopedInput;
  const setInput = useCallback<Dispatch<SetStateAction<string>>>(
    (next) => {
      if (!threadId) {
        setUnscopedInput(next);
        return;
      }
      const previous = getThreadDraft(threadId);
      const value = typeof next === 'function' ? next(previous) : next;
      syncDraftToStorage(threadId, value || undefined);
    },
    [threadId],
  );
  const appliedSeedIdRef = useRef<string | null>(null);

  const [showMentions, setShowMentions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionFilter, setMentionFilter] = useState('');
  const [images, setImages] = useState<File[]>(() => (threadId ? (threadImageDrafts.get(threadId) ?? []) : []));
  const [contextAttachments, setContextAttachments] = useState<ContextAttachment[]>(() =>
    threadId ? (threadContextAttachmentDrafts.get(threadId) ?? []) : [],
  );
  // Context drafts are restored from this browser session, which the server never sees: keep them in state (so the
  // draft sync below never clears them) but render them only once hydration is over, like the text draft.
  const hydrated = useHydrated();
  const shownContextAttachments = hydrated ? contextAttachments : NO_CONTEXT_ATTACHMENTS;
  const [isPreparingImages, setIsPreparingImages] = useState(false);
  const [whisperMode, setWhisperMode] = useState(false);
  const [whisperTargets, setWhisperTargets] = useState<Set<string>>(new Set());

  // F108B AC-B7: In whisper mode, check if SELECTED targets are busy (not thread-level).
  // When all whisper targets are idle → show Send button, not Queue.
  const whisperTargetsAllIdle = useMemo(() => {
    if (!whisperMode || whisperTargets.size === 0) return false;
    return ![...whisperTargets].some((catId) => activeCatIds.has(catId));
  }, [whisperMode, whisperTargets, activeCatIds]);
  const messageDisposition = useMessageDispositionPreference(effectiveThreadId, Boolean(effectiveThreadId));
  const guideReplyNames = cats
    .filter((cat) => activeCatIds.has(cat.id) && cat.messageDeliveryCapabilities?.guideReply === true)
    .map(formatCatDisplayName);
  const guideReplyHint =
    guideReplyNames.length > 0 ? `想调整方向？可直接给${guideReplyNames.join('/')}发消息，引导回复。` : undefined;
  const textareaPlaceholder = whisperMode
    ? shellV2
      ? v2Copy.whisperPlaceholder
      : '悄悄话...'
    : (guideReplyHint ?? placeholder ?? (shellV2 ? v2Copy.placeholder : '输入消息... (@ 召唤猫猫 · /thread 引用对话)'));

  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [contextPickerMode, setContextPickerMode] = useState<ContextPickerMode | null>(null);
  const [contextShortcutRange, setContextShortcutRange] = useState<{ start: number; end: number } | null>(null);
  const [ghostSuggestion, setGhostSuggestion] = useState<string | null>(null);
  const ghostRef = useRef<string | null>(null);
  const [showHistorySearch, setShowHistorySearch] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useComposerKeyboardFocus(shellV2, textareaRef);
  useEffect(() => {
    const handler = (event: Event) => {
      if ((event as CustomEvent<{ threadId: string }>).detail?.threadId === effectiveThreadId)
        textareaRef.current?.focus();
    };
    window.addEventListener('cat-cafe:conversation-answer-bound', handler);
    return () => window.removeEventListener('cat-cafe:conversation-answer-bound', handler);
  }, [effectiveThreadId]);
  const menuRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { insertRecipientMention, preferredCatControl, routingPreview } = useChatComposerRouting({
    enabled: shellV2,
    threadId: effectiveThreadId,
    prospectiveThread,
    content: input,
    setContent: setInput,
    textareaRef,
    whisperMode,
    whisperTargets,
    composing: routingCompositionActive,
  });

  useEffect(() => {
    if (!seed || appliedSeedIdRef.current === seed.id) return;
    appliedSeedIdRef.current = seed.id;
    setInput(seed.text);
    const focusTimer = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [seed, setInput]);
  const threads = useChatStore((s) => s.threads);
  const setThreadHasDraft = useChatStore((s) => s.setThreadHasDraft);
  const workspaceOpenFilePath = useChatStore((s) => s.workspaceOpenFilePath);
  const workspaceWorktreeId = useChatStore((s) => s.workspaceWorktreeId);
  const imageLifecycleStatus = deriveImageLifecycleStatus(isPreparingImages, uploadStatus);

  const {
    beginAdmission: beginComposerDraftAdmission,
    discardUnrestoredImages,
    markOptimisticallyCleared: markComposerDraftOptimisticallyCleared,
    removeImage: removeComposerDraftImage,
    retryUnrestoredImages,
    unrestoredImageCount,
  } = useDurableComposerDraft({
    threadId,
    input,
    setInput,
    images,
    setImages,
    contextAttachments,
    setContextAttachments,
    replyToMessage,
    textareaRef,
    setIsPreparingImages,
  });
  const v2UnrestoredImageCount = shellV2 ? unrestoredImageCount : 0;
  const sendTemporarilyDisabled = isComposerSendBlocked(imageLifecycleStatus, v2UnrestoredImageCount);

  const handleTranscript = useCallback(
    (text: string) => {
      setInput((prev) => {
        const separator = prev && !prev.endsWith(' ') ? ' ' : '';
        return prev + separator + text;
      });
    },
    [setInput],
  );

  const filteredCatOptions = useMemo(() => {
    if (!mentionFilter) return catOptions;
    const lower = mentionFilter.toLowerCase();
    return catOptions.filter(
      (opt) =>
        opt.label.toLowerCase().includes(lower) ||
        opt.insert.toLowerCase().includes(lower) ||
        opt.id.toLowerCase().includes(lower),
    );
  }, [catOptions, mentionFilter]);

  const activeMenu = showMentions ? 'mention' : null;
  const activeOptions = filteredCatOptions;

  const addHistoryEntry = useInputHistoryStore((s) => s.addEntry);
  const findHistoryMatch = useInputHistoryStore((s) => s.findMatch);

  // F080-P2: path completion
  const pathCompletion = usePathCompletion(input);

  const answerCopy = useShellCopy(conversationDecisionCopy);
  const boundAnswerSubmitting = useRef(false);
  const doSend = useCallback(() => {
    if (sendTemporarilyDisabled) return;
    const answer = replyToMessage?.runtimeAnswerContext;
    if (answer) {
      if (disabled || boundAnswerSubmitting.current || !input.trim()) return;
      if (
        answer.cardRef.threadId !== effectiveThreadId ||
        answer.cardRef.messageId !== replyToMessage.id ||
        images.length ||
        contextAttachments.length ||
        whisperMode
      ) {
        useToastStore
          .getState()
          .addToast({ type: 'error', title: answerCopy.changed, message: answerCopy.changed, duration: 6000 });
        return;
      }
      const capturedInput = input;
      const settleAdmission = beginComposerDraftAdmission({
        text: capturedInput,
        images: [],
        contextAttachments: [],
        replyTo: replyToMessage,
      });
      boundAnswerSubmitting.current = true;
      void submitConversationAnswer(answer, { kind: 'text', text: capturedInput.trim() })
        .then(
          () => {
            settleAdmission(true);
            setInput((current) => (current === capturedInput ? '' : current));
            if (useChatStore.getState().replyToMessage?.runtimeAnswerContext?.operationId === answer.operationId)
              clearReplyTo();
          },
          () => {
            settleAdmission(false);
            useToastStore
              .getState()
              .addToast({ type: 'error', title: answerCopy.changed, message: answerCopy.changed, duration: 6000 });
          },
        )
        .finally(() => {
          boundAnswerSubmitting.current = false;
        });
      return;
    }

    if (whisperMode && whisperTargets.size === 0) return;
    const conflict = projectScreeningComposerConflict(composerAttachments(effectiveThreadId, contextAttachments));
    if (conflict) {
      useToastStore
        .getState()
        .addToast({ type: 'error', title: '请先整理审片位置', message: conflict, duration: 6000 });
      return;
    }
    const trimmed = input.trim();
    if ((trimmed || contextAttachments.length > 0) && !disabled) {
      const visibleWork =
        shellV2 && contextAttachments.length === 0 && images.length === 0 && effectiveThreadId
          ? workScope?.read(effectiveThreadId)
          : null;
      const sendContexts = visibleWork ? [visibleWork] : contextAttachments;
      const draftSnapshot = {
        text: input,
        images: [...images],
        contextAttachments: [...contextAttachments],
        replyTo: replyToMessage,
      };
      if (trimmed) addHistoryEntry(trimmed);
      const whisper =
        whisperMode && whisperTargets.size > 0
          ? { visibility: 'whisper' as const, whisperTo: [...whisperTargets] }
          : undefined;
      const settleAdmission = beginComposerDraftAdmission(draftSnapshot);
      let admission: ReturnType<ChatInputProps['onSend']>;
      try {
        admission =
          sendContexts.length > 0
            ? onSend(trimmed, images.length > 0 ? images : undefined, whisper, replyToMessage?.id, sendContexts)
            : onSend(trimmed, images.length > 0 ? images : undefined, whisper, replyToMessage?.id);
      } catch {
        settleAdmission(false);
        return;
      }
      void Promise.resolve(admission).then(
        (accepted) => {
          settleAdmission(accepted === false ? false : undefined);
        },
        () => settleAdmission(false),
      );
      markComposerDraftOptimisticallyCleared();
      setInput('');
      ghostRef.current = null;
      setGhostSuggestion(null);
      setImages([]);
      setContextAttachments([]);
      setShowMentions(false);
      // Only clear the reply snapshot that was actually sent.
      if (replyToMessage && useChatStore.getState().replyToMessage?.id === replyToMessage.id) clearReplyTo();
    }
  }, [
    input,
    answerCopy,
    disabled,
    onSend,
    images,
    contextAttachments,
    workScope,
    shellV2,
    sendTemporarilyDisabled,
    whisperMode,
    whisperTargets,
    addHistoryEntry,
    replyToMessage,
    clearReplyTo,
    beginComposerDraftAdmission,
    markComposerDraftOptimisticallyCleared,
    setInput,
    effectiveThreadId,
  ]);

  const handleSend = useCallback(() => doSend(), [doSend]);

  const closeMenus = useCallback(() => {
    setShowMentions(false);
  }, []);

  const closeContextPicker = useCallback((restoreComposerFocus = true) => {
    setContextPickerMode(null);
    setContextShortcutRange(null);
    if (restoreComposerFocus) setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const openContextPicker = useCallback(
    (mode: ContextPickerMode, shortcutRange: { start: number; end: number } | null = null) => {
      closeMenus();
      setAddMenuOpen(false);
      setContextPickerMode(mode);
      setContextShortcutRange(shortcutRange);
    },
    [closeMenus],
  );

  const addContextAttachment = useCallback(
    (attachment: ContextAttachment) => {
      const parsed = ContextAttachmentSchema.safeParse(attachment);
      if (!parsed.success) return;
      const conflict = projectScreeningComposerConflict([
        ...composerAttachments(effectiveThreadId, contextAttachments),
        parsed.data,
      ]);
      if (conflict) {
        useToastStore
          .getState()
          .addToast({ type: 'error', title: '没能放进输入框', message: conflict, duration: 6000 });
        return;
      }
      setContextAttachments((previous) =>
        [...previous, parsed.data as ContextAttachment].slice(0, CONTEXT_ATTACHMENT_MAX_COUNT),
      );
      if (contextShortcutRange) {
        setInput(
          (previous) => `${previous.slice(0, contextShortcutRange.start)}${previous.slice(contextShortcutRange.end)}`,
        );
      }
      closeContextPicker();
    },
    [closeContextPicker, contextShortcutRange, setInput, contextAttachments, effectiveThreadId],
  );

  const insertMention = useCallback(
    (option: CatOption) => {
      const before = input.slice(0, mentionStart);
      const after = input.slice(textareaRef.current?.selectionStart ?? mentionStart + 1);
      setInput(before + option.insert + after);
      setShowMentions(false);
      setMentionStart(-1);
      setTimeout(() => textareaRef.current?.focus(), 0);
    },
    [input, mentionStart, setInput],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setInput(val);
      const contextShortcut = detectContextShortcut(val);
      if (contextShortcut) {
        openContextPicker(contextShortcut.mode, {
          start: contextShortcut.start,
          end: contextShortcut.end,
        });
        return;
      }
      setContextPickerMode(null);
      setContextShortcutRange(null);
      const trigger = detectMenuTrigger(val, e.target.selectionStart);
      if (trigger?.type === 'mention') {
        setShowMentions(true);
        setMentionStart(trigger.start);
        setMentionFilter(trigger.filter);
        // Bare @ defaults to first individual cat so Enter doesn't accidentally
        // insert a group mention like @thread.  When filter is active the user is
        // intentionally narrowing, so start at 0.
        if (trigger.filter) {
          setSelectedIdx(0);
        } else {
          const idx = catOptions.findIndex((opt) => !opt.isGroup);
          // idx = -1 when no individual cats loaded yet → point past all options
          // so the existing Enter guard (opt === undefined → closeMenus) fires
          // instead of accidentally inserting @thread
          setSelectedIdx(idx >= 0 ? idx : catOptions.length);
        }
      } else {
        closeMenus();
        setMentionFilter('');
      }
    },
    [closeMenus, catOptions, openContextPicker, setInput],
  );

  const handleHistorySelect = useCallback(
    (text: string) => {
      setInput(text);
      setShowHistorySearch(false);
      ghostRef.current = null;
      setGhostSuggestion(null);
      closeMenus();
      setMentionFilter('');
      setTimeout(() => textareaRef.current?.focus(), 0);
    },
    [closeMenus, setInput],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ime.isComposing()) return;

    if (contextPickerMode) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeContextPicker();
      } else if (e.key === 'Enter') {
        e.preventDefault();
      }
      return;
    }

    // F080: Ctrl+R opens history search (clear any active menus first)
    if (e.ctrlKey && e.key === 'r') {
      e.preventDefault();
      closeMenus();
      setMentionFilter('');
      setShowHistorySearch(true);
      return;
    }

    if (activeMenu) {
      if (activeOptions.length === 0) {
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab' || e.key === 'Escape') {
          e.preventDefault();
        }
        closeMenus();
        setMentionFilter('');
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => (i + 1) % activeOptions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => (i - 1 + activeOptions.length) % activeOptions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (activeMenu === 'mention') {
          const opt = filteredCatOptions[selectedIdx];
          if (!opt) {
            closeMenus();
            return;
          }
          insertMention(opt);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenus();
        return;
      }
    }

    // F080-P2: path completion menu keyboard navigation
    if (pathCompletion.isOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        pathCompletion.setSelectedIdx((pathCompletion.selectedIdx + 1) % pathCompletion.entries.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        pathCompletion.setSelectedIdx(
          (pathCompletion.selectedIdx - 1 + pathCompletion.entries.length) % pathCompletion.entries.length,
        );
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const entry = pathCompletion.entries[pathCompletion.selectedIdx];
        if (entry) {
          const newText = pathCompletion.selectEntry(entry);
          setInput(newText);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        pathCompletion.close();
        return;
      }
    }

    // F080: Tab or ArrowRight accepts ghost suggestion (only when no menu is active)
    // ArrowRight only accepts when cursor is at end of input (no selection)
    if (e.key === 'Tab' || e.key === 'ArrowRight') {
      const ta = textareaRef.current;
      const currentVal = ta?.value ?? '';
      const cursorAtEnd = !ta || (ta.selectionStart === ta.selectionEnd && ta.selectionStart === currentVal.length);
      if (e.key === 'ArrowRight' && !cursorAtEnd) {
        // Let ArrowRight move cursor normally when not at end
      } else {
        const match = useInputHistoryStore.getState().findMatch(currentVal);
        if (match) {
          e.preventDefault();
          setInput(match);
          ghostRef.current = null;
          setGhostSuggestion(null);
          return;
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      setIsPreparingImages(true);
      try {
        const toAdd: File[] = [];
        for (let i = 0; i < files.length && images.length + toAdd.length < 5; i++) {
          const f = files[i];
          if (f.type.startsWith('image/')) {
            toAdd.push(await compressImage(f));
          } else {
            toAdd.push(f);
          }
        }
        setImages((prev) => [...prev, ...toAdd].slice(0, 5));
      } finally {
        setIsPreparingImages(false);
      }
      e.target.value = '';
    },
    [images],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length === 0) return;
      e.preventDefault();
      setIsPreparingImages(true);
      try {
        const toAdd: File[] = [];
        for (const file of imageFiles) {
          if (images.length + toAdd.length >= 5) break;
          toAdd.push(await compressImage(file));
        }
        setImages((prev) => [...prev, ...toAdd].slice(0, 5));
      } finally {
        setIsPreparingImages(false);
      }
    },
    [images],
  );

  const handleRemoveImage = removeComposerDraftImage;

  const toggleWhisperTarget = useCallback((catId: string) => {
    setWhisperTargets((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }, []);

  // Clamp selection when the available mention options change.
  useEffect(() => {
    if (!showMentions) return;
    setSelectedIdx((i) => Math.min(i, Math.max(0, filteredCatOptions.length - 1)));
  }, [filteredCatOptions, showMentions]);

  // Reconcile whisperTargets: remove invalid ids + remove newly-active cats (B10)
  useEffect(() => {
    if (!whisperMode) return;
    const validIds = new Set(whisperCats.map((c) => c.id));
    setWhisperTargets((prev) => {
      const filtered = new Set([...prev].filter((id) => validIds.has(id) && !activeCatIds.has(id)));
      return filtered.size === prev.size ? prev : filtered;
    });
  }, [whisperCats, whisperMode, activeCatIds]);

  const handleWhisperToggle = useCallback(() => {
    setWhisperMode((prev) => {
      if (!prev) {
        // F108B P1-1: Default to NO cats selected (design spec Scene 1: "默认都不选")
        setWhisperTargets(new Set());
      }
      return !prev;
    });
  }, []);

  // Text writes are synchronous in setInput; the rendered SSR snapshot can be
  // empty while that canonical store already holds a restored session draft.
  // Persist attachments and reply context before unmount on a thread switch.
  useLayoutEffect(() => {
    if (!threadId) return;
    const hasDraft = input.trim().length > 0 || images.length > 0 || contextAttachments.length > 0;
    const firstPersistenceForThread = replyPersistenceThreadRef.current !== threadId;
    const replyDraft = replyToMessage ?? (firstPersistenceForThread ? (threadReplyDrafts.get(threadId) ?? null) : null);
    syncContextAttachmentDraftToStorage(threadId, contextAttachments);
    // #934: Persist reply context alongside text/image drafts
    syncReplyDraftToStorage(threadId, replyDraft);
    if (images.length > 0) {
      threadImageDrafts.delete(threadId); // move to end (Map insertion order)
      threadImageDrafts.set(threadId, images);
      // LRU eviction: keep only the most recent N threads with image drafts
      while (threadImageDrafts.size > MAX_IMAGE_DRAFT_THREADS) {
        const oldest = threadImageDrafts.keys().next().value;
        if (oldest !== undefined) {
          threadImageDrafts.delete(oldest);
          setThreadHasDraft(oldest, hasPendingThreadDraft(oldest));
        }
      }
    } else {
      threadImageDrafts.delete(threadId);
    }
    setThreadHasDraft(threadId, hasDraft || Boolean(replyDraft));
    replyPersistenceThreadRef.current = threadId;
  }, [input, images, contextAttachments, threadId, setThreadHasDraft, replyToMessage]);

  useEffect(() => {
    onDraftChange?.({
      text: input,
      files: [...images],
      contextAttachments: [...contextAttachments],
    });
  }, [contextAttachments, images, input, onDraftChange]);

  // F080: recalculate ghost suggestion whenever input changes (covers all setInput paths)
  useEffect(() => {
    const match = input.trim() ? findHistoryMatch(input) : null;
    ghostRef.current = match;
    setGhostSuggestion(match);
  }, [input, findHistoryMatch]);

  useTextareaAutosize(textareaRef, input, textareaPlaceholder);

  useEffect(() => {
    if (!activeMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // React 18 may flush state synchronously during event bubbling,
      // detaching the original target (e.g. layer 1 unmounts when drilling
      // into layer 2). A detached target is not a genuine outside click.
      if (!target.isConnected) return;
      if (menuRef.current && !menuRef.current.contains(target)) {
        closeMenus();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [activeMenu, closeMenus]);

  const composerDraftExtras = (
    <ChatComposerDraftExtras
      files={images}
      contextAttachments={shownContextAttachments}
      replyToMessage={replyToMessage}
      cats={cats}
      whisperMode={whisperMode}
      whisperCats={whisperCats}
      whisperTargets={whisperTargets}
      onToggleWhisperTarget={toggleWhisperTarget}
      onRemoveFile={handleRemoveImage}
      onRemoveContext={(id) =>
        setContextAttachments((previous) => previous.filter((attachment) => attachment.id !== id))
      }
      onClearReply={clearReplyTo}
    />
  );
  const hasComposerDraftExtras =
    whisperMode || images.length > 0 || shownContextAttachments.length > 0 || replyToMessage !== null;
  const hasComposerHeader = shellV2 && composerHeader !== undefined && composerHeader !== null;
  const headerRowCount: 0 | 1 = hasComposerHeader ? 1 : 0;
  const draftExtrasRowCount: 0 | 1 = hasComposerDraftExtras ? 1 : 0;
  const draftExtrasRow = COMPOSER_GRID_ROWS[headerRowCount];
  const textareaRow = COMPOSER_GRID_ROWS[(headerRowCount + draftExtrasRowCount) as 0 | 1 | 2];
  const controlsRow = COMPOSER_GRID_ROWS[(headerRowCount + draftExtrasRowCount + 1) as 1 | 2 | 3];
  const inputMenus = (
    <ChatInputMenus
      catOptions={filteredCatOptions}
      showMentions={showMentions}
      selectedIdx={selectedIdx}
      onSelectIdx={setSelectedIdx}
      onInsertMention={insertMention}
      menuRef={menuRef}
    />
  );

  return (
    <div className={`relative safe-area-bottom ${shellV2 ? 'bg-[var(--shell-work)]' : 'bg-[var(--console-shell-bg)]'}`}>
      {contextPickerMode && (
        <ChatContextPicker
          mode={contextPickerMode}
          threads={threads}
          currentThreadId={threadId}
          currentFilePath={workspaceOpenFilePath}
          worktreeId={workspaceWorktreeId}
          onChoose={addContextAttachment}
          onClose={closeContextPicker}
        />
      )}

      {pathCompletion.isOpen && !activeMenu && !contextPickerMode && (
        <PathCompletionMenu
          entries={pathCompletion.entries}
          selectedIdx={pathCompletion.selectedIdx}
          onSelectIdx={pathCompletion.setSelectedIdx}
          onSelect={(entry) => {
            const newText = pathCompletion.selectEntry(entry);
            setInput(newText);
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
        />
      )}

      {!shellV2 && inputMenus}

      {whisperMode && !showMentions && (
        <WhisperCatSelector
          cats={whisperCats}
          selected={whisperTargets}
          activeCatIds={activeCatIds}
          onToggle={toggleWhisperTarget}
        />
      )}

      {imageLifecycleStatus === 'preparing' && (
        <div className="px-4 pt-2 text-xs text-cafe-secondary" role="status">
          附件处理中，完成后可发送
        </div>
      )}
      {imageLifecycleStatus === 'uploading' && (
        <div className="px-4 pt-2 text-xs text-[var(--semantic-info)]" role="status">
          附件上传中，请稍候...
        </div>
      )}
      {imageLifecycleStatus === 'failed' && uploadError && (
        <div className="px-4 pt-2 text-xs text-conn-red-text" role="alert">
          附件发送失败：{uploadError}
        </div>
      )}

      {shellV2 && (
        <RecoveredAttachmentsNotice
          count={unrestoredImageCount}
          discardLabel={v2Copy.discardRecoveredAttachments}
          message={v2Copy.recoveredAttachmentsBlocked}
          preparing={isPreparingImages}
          retryLabel={v2Copy.retryRecoveredAttachments}
          onDiscard={() => void discardUnrestoredImages()}
          onRetry={() => void retryUnrestoredImages()}
        />
      )}

      {!shellV2 && composerDraftExtras}

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />

      {addMenuOpen && (
        <ChatInputAddMenu
          presentation={presentation}
          onAttach={() => fileInputRef.current?.click()}
          onAddContext={() => openContextPicker('all')}
          onWhisperToggle={handleWhisperToggle}
          onClose={() => setAddMenuOpen(false)}
          messageDisposition={messageDisposition}
          triggerRef={addButtonRef}
          disabled={disabled}
          sendDisabled={sendTemporarilyDisabled}
          maxImages={images.length >= 5}
          whisperMode={whisperMode}
          preferredCat={shellV2 ? (preferredCatControl ?? undefined) : undefined}
        />
      )}

      <ComposerFrame
        className={
          shellV2
            ? 'relative mx-4 mb-4 mt-2 grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 px-3 pb-2 pt-2'
            : 'flex gap-2 items-center p-4 pt-2'
        }
        data-testid="chat-input-composer-row"
        data-composer-presentation={presentation}
        active={shellV2}
      >
        {shellV2 && inputMenus}
        {hasComposerHeader ? (
          <div
            className="col-span-3 col-start-1 row-start-1 -mx-2 -mt-2 border-b border-[var(--shell-hairline)] px-3 py-1.5"
            data-testid="chat-composer-header"
          >
            {composerHeader}
          </div>
        ) : null}
        {shellV2 && hasComposerDraftExtras ? (
          <div
            className={`col-span-3 col-start-1 ${draftExtrasRow} -mx-2 ${hasComposerHeader ? '' : '-mt-2 rounded-t-2xl'} border-b border-[var(--shell-hairline)] pb-1`}
            data-testid="chat-composer-draft-extras"
          >
            {composerDraftExtras}
          </div>
        ) : null}
        {/* F284: one stable add entry; context, upload and modes disclose on demand. */}
        <AppTooltip label={v2Copy.addHint} side="top" disabled={!shellV2 || addMenuOpen}>
          <ComposerControl
            ref={addButtonRef}
            active={shellV2}
            type="button"
            onClick={() => {
              closeContextPicker(false);
              closeMenus();
              setAddMenuOpen((open) => !open);
            }}
            disabled={disabled || sendTemporarilyDisabled}
            className={`${
              shellV2 ? `shell-focusable col-start-1 ${controlsRow}` : 'p-3 rounded-xl'
            } transition-all disabled:cursor-not-allowed disabled:opacity-30 ${
              addMenuOpen
                ? 'text-cafe-accent bg-cafe-surface-sunken rotate-45'
                : 'text-cafe-muted hover:text-cafe-accent hover:bg-cafe-surface'
            }`}
            aria-label={shellV2 ? v2Copy.add : '添加'}
            aria-expanded={addMenuOpen}
            aria-controls="composer-add-menu"
            title={shellV2 ? undefined : '添加上下文、上传或打开更多模式'}
          >
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
                clipRule="evenodd"
              />
            </svg>
          </ComposerControl>
        </AppTooltip>

        <div
          className={shellV2 ? `relative col-span-3 col-start-1 ${textareaRow} min-w-0` : 'flex-1 relative'}
          data-bootcamp-step="chat-input"
          data-guide-id="chat.input"
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              ime.onCompositionStart();
              setRoutingCompositionActive(true);
            }}
            onCompositionEnd={() => {
              ime.onCompositionEnd();
              setRoutingCompositionActive(false);
            }}
            onPaste={handlePaste}
            onFocus={() => onFocusChange?.(true)}
            onBlur={() => onFocusChange?.(false)}
            aria-label={shellV2 ? v2Copy.message : '消息输入框'}
            placeholder={textareaPlaceholder}
            className={
              shellV2
                ? `shell-focusable block min-h-[32px] w-full resize-none rounded-lg border-0 bg-transparent px-1 py-1 text-sm leading-6 text-[var(--shell-ink)] placeholder:text-[var(--shell-muted)] ${whisperMode ? 'bg-accent-50/50' : ''}`
                : `w-full resize-none rounded-xl border p-3 text-sm focus:outline-none focus:ring-2 placeholder:text-cafe-muted ${
                    whisperMode
                      ? 'border-cafe-accent/30 bg-accent-50/50 focus:ring-cafe-accent'
                      : 'border-[var(--console-border-soft)] bg-transparent focus:bg-[var(--console-card-bg)] focus:ring-[var(--console-input-stroke)]'
                  }`
            }
            rows={1}
            disabled={disabled}
          />
          {ghostSuggestion && !pathCompletion.isOpen && !contextPickerMode && (
            <div
              data-testid="ghost-suggestion"
              className={`absolute inset-0 pointer-events-none text-sm whitespace-pre-wrap break-words overflow-hidden rounded-xl ${shellV2 ? 'px-1 py-1 leading-6' : 'p-3'}`}
              aria-hidden="true"
            >
              <span className="invisible">{input}</span>
              <span className="text-cafe-muted">{ghostSuggestion.slice(input.length)}</span>
            </div>
          )}
        </div>

        {shellV2 && (
          <div
            className={`col-start-2 ${controlsRow} flex min-w-0 items-center gap-1 border-l border-[var(--shell-hairline)] pl-2 ${
              hasComposerHeader ? 'max-sm:flex-nowrap max-sm:gap-2 max-sm:pl-1.5' : ''
            }`}
            data-testid="chat-composer-context"
          >
            {composerContext}
            <ComposerRoutingPreview
              preview={routingPreview}
              onInsertMention={insertRecipientMention}
              compact={hasComposerHeader}
            />
          </div>
        )}
        <div className={shellV2 ? `col-start-3 ${controlsRow} flex shrink-0 items-center gap-1` : 'contents'}>
          {shellV2 ? <GalleryDraftSummary attachments={shownContextAttachments} /> : null}
          <ChatInputActionButton
            onTranscript={handleTranscript}
            onSend={handleSend}
            onStop={() => void handleProjectedStop()}
            stopState={stopState}
            onQueueSend={handleSend}
            disabled={disabled}
            sendDisabled={sendTemporarilyDisabled}
            hasActiveInvocation={whisperTargetsAllIdle ? false : hasActiveInvocation}
            hasText={Boolean(input.trim() || shownContextAttachments.length > 0)}
            presentation={shellV2 ? 'v2' : 'classic'}
          />
        </div>
      </ComposerFrame>

      {showHistorySearch && (
        <HistorySearchModal onSelect={handleHistorySelect} onClose={() => setShowHistorySearch(false)} />
      )}
    </div>
  );
}
