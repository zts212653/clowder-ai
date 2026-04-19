'use client';

import { KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { reconnectGame } from '@/hooks/useGameReconnect';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { usePathCompletion } from '@/hooks/usePathCompletion';
import type { UploadStatus, WhisperOptions } from '@/hooks/useSendMessage';
import type { DeliveryMode } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useInputHistoryStore } from '@/stores/inputHistoryStore';
import { apiFetch } from '@/utils/api-client';
import { compressImage } from '@/utils/compressImage';
import { ChatInputActionButton } from './ChatInputActionButton';
import { ChatInputMenus } from './ChatInputMenus';
import { buildCatOptions, type CatOption, detectMenuTrigger, GAME_LIST, WEREWOLF_MODES } from './chat-input-options';
import { deriveImageLifecycleStatus, isImageLifecycleBlockingSend } from './chat-input-upload-state';
import { GameLobby, type GameStartPayload } from './game/GameLobby';
import { HistorySearchModal } from './HistorySearchModal';
import { ImagePreview } from './ImagePreview';
import { AttachIcon } from './icons/AttachIcon';
import { MobileInputToolbar } from './MobileInputToolbar';
import { PathCompletionMenu } from './PathCompletionMenu';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { WhisperCatSelector, WhisperTargetChips } from './WhisperCatSelector';

/** Module-level draft storage — survives component unmount/remount across thread switches */
export const threadDrafts = new Map<string, string>();
export const threadImageDrafts = new Map<string, File[]>();
const MAX_IMAGE_DRAFT_THREADS = 5;

interface ChatInputProps {
  /** Thread ID for draft persistence — drafts are saved per-thread */
  threadId?: string;
  onSend: (content: string, images?: File[], whisper?: WhisperOptions, deliveryMode?: DeliveryMode) => void;
  onStop?: () => void;
  disabled?: boolean;
  hasActiveInvocation?: boolean;
  uploadStatus?: UploadStatus;
  uploadError?: string | null;
}

const ACCEPTED_TYPES = 'image/png,image/jpeg,image/gif,image/webp';

export function ChatInput({
  threadId,
  onSend,
  onStop,
  disabled,
  hasActiveInvocation,
  uploadStatus = 'idle',
  uploadError = null,
}: ChatInputProps) {
  const { cats } = useCatData();
  const ime = useIMEGuard();
  const catOptions = useMemo(() => buildCatOptions(cats), [cats]);
  // F108 Scene 2: whisper-eligible cats (CatData[] for WhisperCatSelector)
  const whisperCats = useMemo(() => cats.filter((c) => c.roster?.available !== false), [cats]);

  // F122B AC-B10: track which cats are actively executing (for whisper disable)
  const activeInvocations = useChatStore((s) => s.activeInvocations);
  const storeTargetCats = useChatStore((s) => s.targetCats);
  const activeCatIds = useMemo(() => {
    const ids = new Set<string>();
    for (const inv of Object.values(activeInvocations ?? {})) {
      ids.add(inv.catId);
    }
    // Defensive fallback: legacy paths set hasActiveInvocation=true without
    // populating activeInvocations slots. Use targetCats as degraded source.
    if (ids.size === 0 && hasActiveInvocation && storeTargetCats?.length) {
      for (const catId of storeTargetCats) ids.add(catId);
    }
    return ids;
  }, [activeInvocations, hasActiveInvocation, storeTargetCats]);

  const [input, setInput] = useState(() => (threadId ? (threadDrafts.get(threadId) ?? '') : ''));
  const [showMentions, setShowMentions] = useState(false);
  const [showGameMenu, setShowGameMenu] = useState(false);
  const [gameStep, setGameStep] = useState<'list' | 'modes'>('list');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionFilter, setMentionFilter] = useState('');
  const [images, setImages] = useState<File[]>(() => (threadId ? (threadImageDrafts.get(threadId) ?? []) : []));
  const [isPreparingImages, setIsPreparingImages] = useState(false);
  const [whisperMode, setWhisperMode] = useState(false);
  const [whisperTargets, setWhisperTargets] = useState<Set<string>>(new Set());

  // F108B AC-B7: In whisper mode, check if SELECTED targets are busy (not thread-level).
  // When all whisper targets are idle → show Send button, not Queue.
  const whisperTargetsAllIdle = useMemo(() => {
    if (!whisperMode || whisperTargets.size === 0) return false;
    return ![...whisperTargets].some((catId) => activeCatIds.has(catId));
  }, [whisperMode, whisperTargets, activeCatIds]);

  const [mobileToolbar, setMobileToolbar] = useState(false);
  const [ghostSuggestion, setGhostSuggestion] = useState<string | null>(null);
  const ghostRef = useRef<string | null>(null);
  const [showHistorySearch, setShowHistorySearch] = useState(false);
  const [lobbyMode, setLobbyMode] = useState<'player' | 'god-view' | 'detective' | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const gameBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageLifecycleStatus = deriveImageLifecycleStatus(isPreparingImages, uploadStatus);
  const sendTemporarilyDisabled = isImageLifecycleBlockingSend(imageLifecycleStatus);

  // F63-AC15: consume pendingChatInsert from workspace (thread-guarded)
  const pendingChatInsert = useChatStore((s) => s.pendingChatInsert);
  const setPendingChatInsert = useChatStore((s) => s.setPendingChatInsert);
  useEffect(() => {
    if (!pendingChatInsert) return;
    if (pendingChatInsert.threadId !== threadId) return;
    setInput((prev) => {
      const separator = prev && !prev.endsWith('\n') ? '\n' : '';
      return prev + separator + pendingChatInsert.text;
    });
    setPendingChatInsert(null);
    textareaRef.current?.focus();
  }, [pendingChatInsert, setPendingChatInsert, threadId]);

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
      if (trimmed && !disabled) {
        addHistoryEntry(trimmed);
        const whisper =
          whisperMode && whisperTargets.size > 0
            ? { visibility: 'whisper' as const, whisperTo: [...whisperTargets] }
            : undefined;
        onSend(trimmed, images.length > 0 ? images : undefined, whisper, deliveryMode);
        setInput('');
        ghostRef.current = null;
        setGhostSuggestion(null);
        setImages([]);
        setShowMentions(false);
        setShowGameMenu(false);
      }
    },
    [input, disabled, onSend, images, sendTemporarilyDisabled, whisperMode, whisperTargets, addHistoryEntry],
  );

  const handleSend = useCallback(() => doSend(undefined), [doSend]);
  const handleQueueSend = useCallback(() => doSend('queue'), [doSend]);
  const handleForceSend = useCallback(() => doSend('force'), [doSend]);

  const closeMenus = useCallback(() => {
    setShowMentions(false);
    setShowGameMenu(false);
  }, []);

  const [gameStarting, setGameStarting] = useState(false);

  const startGame = useCallback(
    async (payload: GameStartPayload) => {
      closeMenus();
      if (disabled || sendTemporarilyDisabled || gameStarting) return;
      setGameStarting(true);
      try {
        const res = await apiFetch('/api/game/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          useChatStore.getState().addMessage({
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
        useChatStore.getState().addMessage({
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
    [closeMenus, disabled, sendTemporarilyDisabled, gameStarting],
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
        setSelectedIdx(0);
      } else {
        closeMenus();
        setMentionFilter('');
      }
    },
    [closeMenus],
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
          toAdd.push(await compressImage(files[i]));
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

  const handleRemoveImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

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
    setShowMentions(false);
    setMentionStart(-1);
    setShowGameMenu((prev) => !prev);
    setGameStep('list');
    setSelectedIdx(0);
  }, []);

  const handleWhisperToggle = useCallback(() => {
    setWhisperMode((prev) => {
      if (!prev) {
        // F108B P1-1: Default to NO cats selected (design spec Scene 1: "默认都不选")
        setWhisperTargets(new Set());
      }
      return !prev;
    });
  }, []);

  // Sync input text + images to module-level draft maps (covers all sources: typing, voice, mentions)
  // useLayoutEffect runs synchronously before browser paint and before unmount,
  // ensuring the draft is written to the Map before the component is destroyed
  // on thread switch (key={threadId}). useEffect would lose the final keystroke.
  useLayoutEffect(() => {
    if (!threadId) return;
    if (input) threadDrafts.set(threadId, input);
    else threadDrafts.delete(threadId);
    if (images.length > 0) {
      threadImageDrafts.delete(threadId); // move to end (Map insertion order)
      threadImageDrafts.set(threadId, images);
      // LRU eviction: keep only the most recent N threads with image drafts
      while (threadImageDrafts.size > MAX_IMAGE_DRAFT_THREADS) {
        const oldest = threadImageDrafts.keys().next().value;
        if (oldest !== undefined) threadImageDrafts.delete(oldest);
      }
    } else {
      threadImageDrafts.delete(threadId);
    }
  }, [input, images, threadId]);

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
      if (menuRef.current && !menuRef.current.contains(target) && !gameBtnRef.current?.contains(target)) {
        closeMenus();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [activeMenu, closeMenus]);

  return (
    <div className="border-t border-cocreator-light bg-cocreator-bg relative safe-area-bottom">
      {/* F39: Queue status bar — visible when cat is running */}
      {hasActiveInvocation && (
        <div className="px-4 pt-2 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-[#9B7EBD] animate-pulse" />
          <span className="text-xs text-[#9B7EBD] font-medium">猫猫正在回复中...</span>
          <span className="text-xs text-cafe-muted">继续输入，消息会排队</span>
        </div>
      )}

      {pathCompletion.isOpen && !activeMenu && (
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
          图片处理中，完成后可发送
        </div>
      )}
      {imageLifecycleStatus === 'uploading' && (
        <div className="px-4 pt-2 text-xs text-indigo-500" role="status">
          图片上传中，请稍候...
        </div>
      )}
      {imageLifecycleStatus === 'failed' && uploadError && (
        <div className="px-4 pt-2 text-xs text-red-500" role="alert">
          图片发送失败：{uploadError}
        </div>
      )}

      {whisperMode && (
        <WhisperTargetChips cats={whisperCats} selected={whisperTargets} onToggle={toggleWhisperTarget} />
      )}

      <ImagePreview files={images} onRemove={handleRemoveImage} />

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Mobile expanded toolbar (above input row) */}
      {mobileToolbar && (
        <MobileInputToolbar
          onAttach={() => fileInputRef.current?.click()}
          onWhisperToggle={handleWhisperToggle}
          onGameClick={handleGameClick}
          onClose={() => setMobileToolbar(false)}
          disabled={disabled}
          sendDisabled={sendTemporarilyDisabled}
          maxImages={images.length >= 5}
          whisperMode={whisperMode}
        />
      )}

      <div className="flex gap-2 items-end p-4 pt-2">
        {/* Mobile: + toggle button */}
        <button
          onClick={() => setMobileToolbar((v) => !v)}
          className={`p-3 rounded-xl transition-all md:hidden ${
            mobileToolbar
              ? 'text-cocreator-primary bg-cocreator-light rotate-45'
              : 'text-cafe-muted hover:text-cocreator-primary hover:bg-cafe-surface'
          }`}
          aria-label="展开工具栏"
        >
          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        {/* Desktop: tool buttons always visible */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || sendTemporarilyDisabled || images.length >= 5}
          className="hidden md:block p-3 rounded-xl text-cafe-muted hover:text-cocreator-primary hover:bg-cafe-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Attach images"
        >
          <AttachIcon className="w-5 h-5" />
        </button>

        <button
          onClick={handleWhisperToggle}
          disabled={disabled || sendTemporarilyDisabled}
          className={`hidden md:block p-3 rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
            whisperMode
              ? 'text-amber-500 bg-amber-50 ring-1 ring-amber-300'
              : 'text-cafe-muted hover:text-amber-500 hover:bg-cafe-surface'
          }`}
          aria-label="Whisper mode"
          title="悄悄话模式"
        >
          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        <button
          ref={gameBtnRef}
          onClick={handleGameClick}
          disabled={disabled || sendTemporarilyDisabled}
          className="hidden md:block p-3 rounded-xl text-cafe-muted hover:text-indigo-500 hover:bg-cafe-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Game mode"
          title="游戏模式"
        >
          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M5 3a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2V5a2 2 0 00-2-2H5zM5 11a2 2 0 00-2 2v2a2 2 0 002 2h2a2 2 0 002-2v-2a2 2 0 00-2-2H5zM11 5a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V5zM14 11a1 1 0 011 1v1h1a1 1 0 110 2h-1v1a1 1 0 11-2 0v-1h-1a1 1 0 110-2h1v-1a1 1 0 011-1z" />
          </svg>
        </button>

        <div className="flex-1 relative">
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
                  ? '继续输入，消息会排队...'
                  : '输入消息... (@ 召唤猫猫)'
            }
            className={`w-full resize-none rounded-xl border p-3 text-sm focus:outline-none focus:ring-2 placeholder:text-gray-400 ${
              whisperMode
                ? 'border-amber-300 bg-amber-50/50 focus:ring-amber-400'
                : 'border-cocreator-light bg-cafe-surface focus:ring-cocreator-primary'
            }`}
            rows={1}
            disabled={disabled}
          />
          {ghostSuggestion && !pathCompletion.isOpen && (
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
          onStop={onStop}
          onQueueSend={handleQueueSend}
          onForceSend={handleForceSend}
          disabled={disabled}
          sendDisabled={sendTemporarilyDisabled}
          hasActiveInvocation={whisperTargetsAllIdle ? false : hasActiveInvocation}
          hasText={!!input.trim()}
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
