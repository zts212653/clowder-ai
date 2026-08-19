'use client';

import {
  CONTEXT_ATTACHMENT_MAX_COUNT,
  type ContextAttachment,
  ContextAttachmentSchema,
  type FreshnessCarrierCapability,
  type MessageWorkDisposition,
} from '@cat-cafe/shared';
import { KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useExecutionRecoveryVerification } from '@/hooks/useExecutionRecoveryVerification';
import { reconnectGame } from '@/hooks/useGameReconnect';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { useLiveExecutionCancelControl } from '@/hooks/useLiveExecutionCancelControl';
import { useMessageDispositionPreference } from '@/hooks/useMessageDispositionPreference';
import { usePathCompletion } from '@/hooks/usePathCompletion';
import type { UploadStatus, WhisperOptions } from '@/hooks/useSendMessage';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import type { DeliveryMode } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useInputHistoryStore } from '@/stores/inputHistoryStore';
import { apiFetch } from '@/utils/api-client';
import { compressImage } from '@/utils/compressImage';
import { AttachmentPreview } from './AttachmentPreview';
import { ChatContextPicker } from './ChatContextPicker';
import { ChatInputActionButton } from './ChatInputActionButton';
import { ChatInputAddMenu } from './ChatInputAddMenu';
import { ChatInputMenus } from './ChatInputMenus';
import { ContextAttachmentList } from './ContextAttachmentView';
import { type ContextPickerMode, detectContextShortcut } from './chat-context-reference';
import { buildCatOptions, type CatOption, detectMenuTrigger, GAME_LIST, WEREWOLF_MODES } from './chat-input-options';
import { deriveImageLifecycleStatus, isImageLifecycleBlockingSend } from './chat-input-upload-state';
import { GameLobby, type GameStartPayload } from './game/GameLobby';
import { HistorySearchModal } from './HistorySearchModal';
import { MessageDispositionSelector } from './MessageDispositionSelector';
import { classifyFreshnessCarrierSupport } from './message-disposition-presentation';
import { PathCompletionMenu } from './PathCompletionMenu';
import { ReplyPreviewBar } from './ReplyPreviewBar';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import {
  hasPendingThreadDraft,
  syncContextAttachmentDraftToStorage,
  syncDraftToStorage,
  syncReplyDraftToStorage,
  threadContextAttachmentDrafts,
  threadDrafts,
  threadImageDrafts,
  threadReplyDrafts,
} from './thread-drafts';
import { useDurableComposerDraft } from './useDurableComposerDraft';
import { WhisperCatSelector, WhisperTargetChips } from './WhisperCatSelector';

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

interface ChatInputProps {
  /** Thread ID for draft persistence — drafts are saved per-thread */
  threadId?: string;
  onSend: (
    content: string,
    images?: File[],
    whisper?: WhisperOptions,
    deliveryMode?: DeliveryMode,
    replyToId?: string,
    messageDisposition?: MessageWorkDisposition,
    contextAttachments?: ContextAttachment[],
  ) => void | boolean | Promise<void | boolean>;
  disabled?: boolean;
  hasActiveInvocation?: boolean;
  uploadStatus?: UploadStatus;
  uploadError?: string | null;
}

const ACCEPTED_TYPES =
  'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/json,application/zip,application/gzip,application/x-tar,application/octet-stream,audio/mpeg,audio/wav,audio/ogg,video/mp4,video/webm';

export function ChatInput({
  threadId,
  onSend,
  disabled,
  hasActiveInvocation: unscopedHasActiveInvocation,
  uploadStatus = 'idle',
  uploadError = null,
}: ChatInputProps) {
  const { cats } = useCatData();
  const ime = useIMEGuard();
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
    activeInvocations,
    catInvocations,
    targetCats: storeTargetCats,
  } = useThreadLiveness(threadId ?? currentThreadId);
  const effectiveThreadId = threadId ?? currentThreadId;
  const {
    executions: canonicalExecutions,
    state: projectedCancelState,
    cancelAll: handleProjectedStop,
  } = useLiveExecutionCancelControl(effectiveThreadId);
  // Shared with ThreadExecutionBar: both surfaces must answer "can we verify this
  // thread's run state?" identically, or their independent fail-closed choices can
  // combine into a state with no cancel AND no recovery exit.
  const { canonicalProjectionStale, hasUnverifiedLegacyExecution } = useExecutionRecoveryVerification(
    threadId,
    unscopedHasActiveInvocation,
  );
  const hasActiveInvocation = canonicalExecutions.length > 0 || hasUnverifiedLegacyExecution;
  const stopState: 'available' | 'pending' | 'unavailable' | 'hidden' =
    canonicalExecutions.length === 0 ? (hasUnverifiedLegacyExecution ? 'unavailable' : 'hidden') : projectedCancelState;
  const activeCatIds = useMemo(() => {
    const ids = new Set<string>();
    for (const execution of canonicalExecutions) {
      ids.add(execution.catId);
    }
    if (ids.size === 0 && hasUnverifiedLegacyExecution) {
      for (const inv of Object.values(activeInvocations ?? {})) ids.add(inv.catId);
      if (ids.size === 0 && storeTargetCats?.length) {
        for (const catId of storeTargetCats) ids.add(catId);
      }
    }
    return ids;
  }, [activeInvocations, canonicalExecutions, hasUnverifiedLegacyExecution, storeTargetCats]);

  const [input, setInput] = useState(() => (threadId ? (threadDrafts.get(threadId) ?? '') : ''));
  const [showMentions, setShowMentions] = useState(false);
  const [showGameMenu, setShowGameMenu] = useState(false);
  const [gameStep, setGameStep] = useState<'list' | 'modes'>('list');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionFilter, setMentionFilter] = useState('');
  const [images, setImages] = useState<File[]>(() => (threadId ? (threadImageDrafts.get(threadId) ?? []) : []));
  const [contextAttachments, setContextAttachments] = useState<ContextAttachment[]>(() =>
    threadId ? (threadContextAttachmentDrafts.get(threadId) ?? []) : [],
  );
  const [isPreparingImages, setIsPreparingImages] = useState(false);
  const [whisperMode, setWhisperMode] = useState(false);
  const [whisperTargets, setWhisperTargets] = useState<Set<string>>(new Set());

  // F108B AC-B7: In whisper mode, check if SELECTED targets are busy (not thread-level).
  // When all whisper targets are idle → show Send button, not Queue.
  const whisperTargetsAllIdle = useMemo(() => {
    if (!whisperMode || whisperTargets.size === 0) return false;
    return ![...whisperTargets].some((catId) => activeCatIds.has(catId));
  }, [whisperMode, whisperTargets, activeCatIds]);
  const dispositionIsMeaningful = Boolean(hasActiveInvocation && !whisperTargetsAllIdle);
  const messageDisposition = useMessageDispositionPreference(threadId, dispositionIsMeaningful);
  const dispositionCarrierCapabilities = useMemo(() => {
    const targetCatIds = whisperMode
      ? [...whisperTargets].filter((catId) => activeCatIds.has(catId))
      : [...activeCatIds];
    return targetCatIds.map((catId) => catInvocations[catId]?.freshnessCarrierCapability) as (
      | FreshnessCarrierCapability
      | undefined
    )[];
  }, [activeCatIds, catInvocations, whisperMode, whisperTargets]);
  const dispositionCarrierSupport = classifyFreshnessCarrierSupport(dispositionCarrierCapabilities);
  const displayedDisposition =
    messageDisposition.effective === 'continue_current' && dispositionCarrierSupport !== 'exact'
      ? 'next_work'
      : messageDisposition.effective;

  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [contextPickerMode, setContextPickerMode] = useState<ContextPickerMode | null>(null);
  const [contextShortcutRange, setContextShortcutRange] = useState<{ start: number; end: number } | null>(null);
  const [ghostSuggestion, setGhostSuggestion] = useState<string | null>(null);
  const ghostRef = useRef<string | null>(null);
  const [showHistorySearch, setShowHistorySearch] = useState(false);
  const [lobbyMode, setLobbyMode] = useState<'player' | 'god-view' | 'detective' | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const threads = useChatStore((s) => s.threads);
  const setThreadHasDraft = useChatStore((s) => s.setThreadHasDraft);
  const workspaceOpenFilePath = useChatStore((s) => s.workspaceOpenFilePath);
  const workspaceWorktreeId = useChatStore((s) => s.workspaceWorktreeId);
  const imageLifecycleStatus = deriveImageLifecycleStatus(isPreparingImages, uploadStatus);
  const sendTemporarilyDisabled = isImageLifecycleBlockingSend(imageLifecycleStatus);

  const {
    beginAdmission: beginComposerDraftAdmission,
    markOptimisticallyCleared: markComposerDraftOptimisticallyCleared,
    removeImage: removeComposerDraftImage,
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

  const handleTranscript = useCallback((text: string) => {
    setInput((prev) => {
      const separator = prev && !prev.endsWith(' ') ? ' ' : '';
      return prev + separator + text;
    });
  }, []);

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

  const activeMenu = showMentions ? 'mention' : showGameMenu ? 'game' : null;
  const gameMenuItems = gameStep === 'list' ? GAME_LIST : WEREWOLF_MODES;
  const activeOptions = activeMenu === 'mention' ? filteredCatOptions : (gameMenuItems as unknown as CatOption[]);

  const addHistoryEntry = useInputHistoryStore((s) => s.addEntry);
  const findHistoryMatch = useInputHistoryStore((s) => s.findMatch);

  // F080-P2: path completion
  const pathCompletion = usePathCompletion(input);

  const doSend = useCallback(
    (deliveryMode?: DeliveryMode) => {
      if (sendTemporarilyDisabled) return;
      if (whisperMode && whisperTargets.size === 0) return;
      const trimmed = input.trim();
      if ((trimmed || contextAttachments.length > 0) && !disabled) {
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
        // Only a one-shot override belongs on this message. Thread/global/product
        // inheritance resolves again at server admission, closing hydration races.
        const declaredDisposition =
          dispositionIsMeaningful && deliveryMode !== 'force'
            ? dispositionCarrierSupport === 'exact'
              ? (messageDisposition.oneShot ?? undefined)
              : 'next_work'
            : undefined;
        const settleAdmission = beginComposerDraftAdmission(draftSnapshot);
        let admission: ReturnType<ChatInputProps['onSend']>;
        try {
          admission =
            contextAttachments.length > 0
              ? onSend(
                  trimmed,
                  images.length > 0 ? images : undefined,
                  whisper,
                  deliveryMode,
                  replyToMessage?.id,
                  declaredDisposition,
                  contextAttachments,
                )
              : onSend(
                  trimmed,
                  images.length > 0 ? images : undefined,
                  whisper,
                  deliveryMode,
                  replyToMessage?.id,
                  declaredDisposition,
                );
        } catch {
          settleAdmission(false);
          return;
        }
        void Promise.resolve(admission).then(
          (accepted) => settleAdmission(accepted === false ? false : undefined),
          () => settleAdmission(false),
        );
        if (declaredDisposition && messageDisposition.oneShot !== null) {
          void Promise.resolve(admission).then((accepted) => {
            if (accepted !== false) messageDisposition.clearOneShot();
          });
        }
        markComposerDraftOptimisticallyCleared();
        setInput('');
        ghostRef.current = null;
        setGhostSuggestion(null);
        setImages([]);
        setContextAttachments([]);
        setShowMentions(false);
        setShowGameMenu(false);
        // Only clear the reply snapshot that was actually sent.
        if (replyToMessage && useChatStore.getState().replyToMessage?.id === replyToMessage.id) clearReplyTo();
      }
    },
    [
      input,
      disabled,
      onSend,
      images,
      contextAttachments,
      sendTemporarilyDisabled,
      whisperMode,
      whisperTargets,
      addHistoryEntry,
      replyToMessage,
      clearReplyTo,
      dispositionIsMeaningful,
      messageDisposition,
      dispositionCarrierSupport,
      beginComposerDraftAdmission,
      markComposerDraftOptimisticallyCleared,
    ],
  );

  const handleSend = useCallback(() => doSend(undefined), [doSend]);
  const handleQueueSend = useCallback(() => doSend('queue'), [doSend]);
  const handleForceSend = useCallback(() => doSend('force'), [doSend]);

  const closeMenus = useCallback(() => {
    setShowMentions(false);
    setShowGameMenu(false);
  }, []);

  const closeContextPicker = useCallback(() => {
    setContextPickerMode(null);
    setContextShortcutRange(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
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
    [closeContextPicker, contextShortcutRange],
  );

  const [gameStarting, setGameStarting] = useState(false);

  const startGame = useCallback(
    async (payload: GameStartPayload) => {
      closeMenus();
      if (disabled || sendTemporarilyDisabled || gameStarting) return;
      const targetThreadId = threadId ?? useChatStore.getState().currentThreadId;
      setGameStarting(true);
      try {
        const res = await apiFetch('/api/game/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          useChatStore.getState().addMessageToThread(targetThreadId, {
            id: `game-err-${Date.now()}`,
            type: 'system',
            variant: 'error',
            content: `开局失败: ${data.error ?? `HTTP ${res.status}`}`,
            timestamp: Date.now(),
          });
          // Restore lobby so user can retry without re-selecting
          setLobbyMode(payload.humanRole);
          return;
        }
        // Success — dismiss lobby and navigate
        setLobbyMode(null);
        pushThreadRouteWithHistory(data.gameThreadId, typeof window !== 'undefined' ? window : undefined);
        // Hydrate game state immediately (socket reconnect won't fire for same connection)
        reconnectGame(data.gameThreadId).catch(() => {});
      } catch (err) {
        useChatStore.getState().addMessageToThread(targetThreadId, {
          id: `game-err-${Date.now()}`,
          type: 'system',
          variant: 'error',
          content: `开局失败: ${err instanceof Error ? err.message : '网络异常'}`,
          timestamp: Date.now(),
        });
        // Restore lobby so user can retry
        setLobbyMode(payload.humanRole);
      } finally {
        setGameStarting(false);
      }
    },
    [closeMenus, disabled, sendTemporarilyDisabled, gameStarting, threadId],
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
    [input, mentionStart],
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
      if (trigger?.type === 'game') {
        setShowGameMenu(true);
        setGameStep('list');
        setShowMentions(false);
        setSelectedIdx(0);
      } else if (trigger?.type === 'mention') {
        setShowMentions(true);
        setShowGameMenu(false);
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
    [closeMenus, catOptions, openContextPicker],
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
    [closeMenus],
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
        } else if (gameStep === 'list') {
          // Layer 1: drill into mode selection
          setGameStep('modes');
          setSelectedIdx(0);
        } else {
          // Layer 2: open lobby for mode configuration
          const mode = WEREWOLF_MODES[selectedIdx];
          const role = mode.id === 'detective' ? 'detective' : mode.id.startsWith('god') ? 'god-view' : 'player';
          closeMenus();
          setLobbyMode(role as 'player' | 'god-view' | 'detective');
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
      // F39+F108B: Enter while cat running → queue send; whisper to idle targets → normal send
      if (hasActiveInvocation && !whisperTargetsAllIdle) handleQueueSend();
      else handleSend();
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

  // Clamp selectedIdx when catOptions shrink — only when mention menu is active.
  // selectedIdx is shared by mention/game menus; clamping to catOptions.length
  // when game menu is open would corrupt game selection.
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

  const handleGameClick = useCallback(() => {
    setAddMenuOpen(false);
    closeContextPicker();
    setShowMentions(false);
    setMentionStart(-1);
    setShowGameMenu((prev) => !prev);
    setGameStep('list');
    setSelectedIdx(0);
  }, [closeContextPicker]);

  const handleWhisperToggle = useCallback(() => {
    setWhisperMode((prev) => {
      if (!prev) {
        // F108B P1-1: Default to NO cats selected (design spec Scene 1: "默认都不选")
        setWhisperTargets(new Set());
      }
      return !prev;
    });
  }, []);

  // Sync text, images, context attachments, and reply context to thread-scoped draft stores.
  // useLayoutEffect runs synchronously before browser paint and before unmount,
  // ensuring the draft is written to the Map before the component is destroyed
  // on thread switch (key={threadId}). useEffect would lose the final keystroke.
  useLayoutEffect(() => {
    if (!threadId) return;
    const hasDraft = input.trim().length > 0 || images.length > 0 || contextAttachments.length > 0;
    const firstPersistenceForThread = replyPersistenceThreadRef.current !== threadId;
    const replyDraft = replyToMessage ?? (firstPersistenceForThread ? (threadReplyDrafts.get(threadId) ?? null) : null);
    syncDraftToStorage(threadId, input || undefined);
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

  // F080: recalculate ghost suggestion whenever input changes (covers all setInput paths)
  useEffect(() => {
    const match = input.trim() ? findHistoryMatch(input) : null;
    ghostRef.current = match;
    setGhostSuggestion(match);
  }, [input, findHistoryMatch]);

  // Auto-resize textarea based on content
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const isMobile = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 767px)').matches : false;
    const maxH = isMobile ? 120 : 200; // ~5 lines mobile, ~8 lines desktop
    ta.style.height = `${Math.min(ta.scrollHeight, maxH)}px`;
  }, [input]);

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

  return (
    <div className="relative bg-[var(--console-shell-bg)] safe-area-bottom">
      {/* F39: Queue status bar — visible when cat is running */}
      {hasActiveInvocation && (
        <div data-testid="active-invocation-banner" className="px-4 pt-2 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-[var(--color-cocreator-primary)] animate-pulse" />
          <span className="text-xs text-[var(--color-cocreator-primary)] font-medium">
            {canonicalExecutions.length > 0
              ? canonicalProjectionStale
                ? '猫猫正在回复中 · 状态暂不可核对'
                : '猫猫正在回复中...'
              : canonicalProjectionStale
                ? '运行状态暂不可核对'
                : '正在确认运行状态...'}
          </span>
          <span className="text-xs text-cafe-muted flex-1">
            {displayedDisposition === 'continue_current' ? '当前轮可在安全断点读取' : '继续输入，消息会成为下一件工作'}
          </span>
          {stopState !== 'hidden' && (
            <button
              type="button"
              data-testid="banner-cancel-btn"
              onClick={() => void handleProjectedStop()}
              disabled={stopState !== 'available'}
              className="text-xs text-cafe-muted hover:text-cafe-primary transition-colors px-2 py-0.5 rounded-md hover:bg-cafe-surface-elevated flex-shrink-0 disabled:cursor-wait disabled:opacity-50"
              aria-label="Stop generation"
            >
              {stopState === 'pending' ? '正在停止' : stopState === 'available' ? '取消' : '暂不可取消'}
            </button>
          )}
        </div>
      )}

      {dispositionIsMeaningful && (
        <MessageDispositionSelector
          controller={messageDisposition}
          carrierSupport={dispositionCarrierSupport}
          carrierCapabilities={dispositionCarrierCapabilities}
        />
      )}

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

      <ChatInputMenus
        catOptions={filteredCatOptions}
        showMentions={showMentions}
        showGameMenu={showGameMenu}
        gameStep={gameStep}
        onGameStepChange={setGameStep}
        selectedIdx={selectedIdx}
        onSelectIdx={setSelectedIdx}
        onInsertMention={insertMention}
        onSendCommand={(command) => {
          // Open lobby instead of sending directly
          const role = command.includes('detective')
            ? 'detective'
            : command.includes('god-view')
              ? 'god-view'
              : 'player';
          closeMenus();
          setLobbyMode(role as 'player' | 'god-view' | 'detective');
        }}
        menuRef={menuRef}
      />

      {whisperMode && !showMentions && !showGameMenu && (
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

      {whisperMode && (
        <WhisperTargetChips cats={whisperCats} selected={whisperTargets} onToggle={toggleWhisperTarget} />
      )}

      <AttachmentPreview files={images} onRemove={handleRemoveImage} />

      <ContextAttachmentList
        attachments={contextAttachments}
        compact
        onRemove={(id) => setContextAttachments((previous) => previous.filter((attachment) => attachment.id !== id))}
      />

      {/* #699: Reply preview bar — matches ReplyPill styling with sender theme color */}
      {replyToMessage && <ReplyPreviewBar replyToMessage={replyToMessage} cats={cats} onClear={clearReplyTo} />}

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
          onAttach={() => fileInputRef.current?.click()}
          onAddContext={() => openContextPicker('all')}
          onWhisperToggle={handleWhisperToggle}
          onGameClick={handleGameClick}
          onClose={() => setAddMenuOpen(false)}
          triggerRef={addButtonRef}
          disabled={disabled}
          sendDisabled={sendTemporarilyDisabled}
          maxImages={images.length >= 5}
          whisperMode={whisperMode}
        />
      )}

      <div className="flex gap-2 items-center p-4 pt-2" data-testid="chat-input-composer-row">
        {/* F284: one stable add entry; context, upload and modes disclose on demand. */}
        <button
          ref={addButtonRef}
          type="button"
          onClick={() => {
            closeContextPicker();
            closeMenus();
            setAddMenuOpen((open) => !open);
          }}
          disabled={disabled || sendTemporarilyDisabled}
          className={`p-3 rounded-xl transition-all disabled:cursor-not-allowed disabled:opacity-30 ${
            addMenuOpen
              ? 'text-cafe-accent bg-cafe-surface-sunken rotate-45'
              : 'text-cafe-muted hover:text-cafe-accent hover:bg-cafe-surface'
          }`}
          aria-label="添加"
          aria-expanded={addMenuOpen}
          aria-controls="composer-add-menu"
          title="添加上下文、上传或打开更多模式"
        >
          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        <div className="flex-1 relative" data-bootcamp-step="chat-input" data-guide-id="chat.input">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onPaste={handlePaste}
            placeholder={
              whisperMode
                ? '悄悄话...'
                : hasActiveInvocation && !whisperTargetsAllIdle
                  ? displayedDisposition === 'continue_current'
                    ? '接着当前工作补充...'
                    : '继续输入，成为下一件工作...'
                  : '输入消息... (@ 召唤猫猫 · /thread 引用对话)'
            }
            className={`w-full resize-none rounded-xl border p-3 text-sm focus:outline-none focus:ring-2 placeholder:text-cafe-muted ${
              whisperMode
                ? 'border-cafe-accent/30 bg-accent-50/50 focus:ring-cafe-accent'
                : 'border-[var(--console-border-soft)] bg-transparent focus:bg-[var(--console-card-bg)] focus:ring-[var(--console-input-stroke)]'
            }`}
            rows={1}
            disabled={disabled}
          />
          {ghostSuggestion && !pathCompletion.isOpen && !contextPickerMode && (
            <div
              data-testid="ghost-suggestion"
              className="absolute inset-0 pointer-events-none p-3 text-sm whitespace-pre-wrap break-words overflow-hidden rounded-xl"
              aria-hidden="true"
            >
              <span className="invisible">{input}</span>
              <span className="text-cafe-muted">{ghostSuggestion.slice(input.length)}</span>
            </div>
          )}
        </div>

        <ChatInputActionButton
          onTranscript={handleTranscript}
          onSend={handleSend}
          onStop={() => void handleProjectedStop()}
          stopState={stopState}
          onQueueSend={handleQueueSend}
          onForceSend={handleForceSend}
          disabled={disabled}
          sendDisabled={sendTemporarilyDisabled}
          hasActiveInvocation={whisperTargetsAllIdle ? false : hasActiveInvocation}
          hasText={Boolean(input.trim() || contextAttachments.length > 0)}
        />
      </div>

      {showHistorySearch && (
        <HistorySearchModal onSelect={handleHistorySelect} onClose={() => setShowHistorySearch(false)} />
      )}

      {lobbyMode && (
        <GameLobby
          mode={lobbyMode}
          cats={cats}
          onConfirm={(payload) => {
            startGame(payload);
          }}
          onCancel={() => setLobbyMode(null)}
        />
      )}
    </div>
  );
}
