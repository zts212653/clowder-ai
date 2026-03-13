'use client';

import { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { usePathCompletion } from '@/hooks/usePathCompletion';
import type { UploadStatus, WhisperOptions } from '@/hooks/useSendMessage';
import type { DeliveryMode } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useInputHistoryStore } from '@/stores/inputHistoryStore';
import { compressImage } from '@/utils/compressImage';
import { ChatInputActionButton } from './ChatInputActionButton';
import { ChatInputMenus } from './ChatInputMenus';
import {
  buildCatOptions,
  buildWhisperOptions,
  type CatOption,
  detectMenuTrigger,
  GAME_LIST,
  WEREWOLF_MODES,
} from './chat-input-options';
import { deriveImageLifecycleStatus, isImageLifecycleBlockingSend } from './chat-input-upload-state';
import { HistorySearchModal } from './HistorySearchModal';
import { ImagePreview } from './ImagePreview';
import { AttachIcon } from './icons/AttachIcon';
import { MobileInputToolbar } from './MobileInputToolbar';
import { PathCompletionMenu } from './PathCompletionMenu';

/** Module-level draft storage — survives component unmount/remount across thread switches */
export const threadDrafts = new Map<string, string>();

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
  const catOptions = useMemo(() => buildCatOptions(cats), [cats]);
  const whisperOptions = useMemo(() => buildWhisperOptions(cats), [cats]);

  const [input, setInput] = useState(() => (threadId ? (threadDrafts.get(threadId) ?? '') : ''));
  const [showMentions, setShowMentions] = useState(false);
  const [showGameMenu, setShowGameMenu] = useState(false);
  const [gameStep, setGameStep] = useState<'list' | 'modes'>('list');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionFilter, setMentionFilter] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [isPreparingImages, setIsPreparingImages] = useState(false);
  const [whisperMode, setWhisperMode] = useState(false);
  const [whisperTargets, setWhisperTargets] = useState<Set<string>>(new Set());
  const [mobileToolbar, setMobileToolbar] = useState(false);
  const [ghostSuggestion, setGhostSuggestion] = useState<string | null>(null);
  const ghostRef = useRef<string | null>(null);
  const [showHistorySearch, setShowHistorySearch] = useState(false);
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

  const sendGameCommand = useCallback(
    (command: string) => {
      closeMenus();
      if (!disabled && !sendTemporarilyDisabled) {
        onSend(command, undefined, undefined, hasActiveInvocation ? 'queue' : undefined);
      }
    },
    [closeMenus, disabled, sendTemporarilyDisabled, onSend, hasActiveInvocation],
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
    if (e.nativeEvent.isComposing) return;

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
          // Layer 2: send selected mode command directly
          sendGameCommand(WEREWOLF_MODES[selectedIdx].command);
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
      // F39: Enter while cat running → queue send; normal otherwise
      if (hasActiveInvocation) handleQueueSend();
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

  // Reconcile whisperTargets when whisperOptions change (e.g. after API fetch replaces fallback)
  useEffect(() => {
    if (!whisperMode) return;
    const validIds = new Set(whisperOptions.map((c) => c.id));
    setWhisperTargets((prev) => {
      const filtered = new Set([...prev].filter((id) => validIds.has(id)));
      return filtered.size === prev.size ? prev : filtered;
    });
  }, [whisperOptions, whisperMode]);

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
        // Entering whisper mode — auto-select all cats (including those without mentionPatterns)
        setWhisperTargets(new Set(whisperOptions.map((c) => c.id)));
      }
      return !prev;
    });
  }, [whisperOptions]);

  // Sync input text to module-level draft map (covers all sources: typing, voice, mentions)
  useEffect(() => {
    if (!threadId) return;
    if (input) threadDrafts.set(threadId, input);
    else threadDrafts.delete(threadId);
  }, [input, threadId]);

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
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        !gameBtnRef.current?.contains(target)
      ) {
        closeMenus();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [activeMenu, closeMenus]);

  return (
    <div className="border-t border-owner-light bg-owner-bg relative safe-area-bottom">
      {/* F39: Queue status bar — visible when cat is running */}
      {hasActiveInvocation && (
        <div className="px-4 pt-2 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-[#9B7EBD] animate-pulse" />
          <span className="text-xs text-[#9B7EBD] font-medium">猫猫正在回复中...</span>
          <span className="text-xs text-gray-400">继续输入，消息会排队</span>
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
        onSendCommand={sendGameCommand}
        menuRef={menuRef}
      />

      {imageLifecycleStatus === 'preparing' && (
        <div className="px-4 pt-2 text-xs text-gray-500" role="status">
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
        <div className="px-4 pt-2 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-amber-600 font-medium">悄悄话发给:</span>
          {whisperOptions.map((cat) => (
            <button
              key={cat.id}
              onClick={() => toggleWhisperTarget(cat.id)}
              className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                whisperTargets.has(cat.id)
                  ? 'border-current bg-amber-50 font-medium'
                  : 'text-gray-400 border-gray-200 hover:border-gray-400'
              }`}
              style={whisperTargets.has(cat.id) ? { color: cat.color } : undefined}
            >
              {cat.label.replace('@', '')}
            </button>
          ))}
          {whisperTargets.size === 0 && <span className="text-xs text-red-400">请至少选一只猫猫</span>}
        </div>
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
              ? 'text-owner-primary bg-owner-light rotate-45'
              : 'text-gray-400 hover:text-owner-primary hover:bg-white'
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
          className="hidden md:block p-3 rounded-xl text-gray-400 hover:text-owner-primary hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
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
              : 'text-gray-400 hover:text-amber-500 hover:bg-white'
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
          className="hidden md:block p-3 rounded-xl text-gray-400 hover:text-indigo-500 hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
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
            onPaste={handlePaste}
            placeholder={
              whisperMode ? '悄悄话...' : hasActiveInvocation ? '继续输入，消息会排队...' : '输入消息... (@ 召唤猫猫)'
            }
            className={`w-full resize-none rounded-xl border p-3 text-sm focus:outline-none focus:ring-2 placeholder:text-gray-400 ${
              whisperMode
                ? 'border-amber-300 bg-amber-50/50 focus:ring-amber-400'
                : 'border-owner-light bg-white focus:ring-owner-primary'
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
              <span className="text-gray-400">{ghostSuggestion.slice(input.length)}</span>
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
          hasActiveInvocation={hasActiveInvocation}
          hasText={!!input.trim()}
        />
      </div>

      {showHistorySearch && (
        <HistorySearchModal onSelect={handleHistorySelect} onClose={() => setShowHistorySearch(false)} />
      )}
    </div>
  );
}
