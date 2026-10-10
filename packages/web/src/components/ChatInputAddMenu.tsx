'use client';

import { type RefObject, useEffect, useRef, useState } from 'react';
import type { MessageDispositionPreferenceController } from '@/hooks/useMessageDispositionPreference';
import { AttachIcon } from './icons/AttachIcon';
import { GameIcon } from './icons/GameIcon';
import { MessageDispositionSelector, messageDispositionLabel } from './MessageDispositionSelector';

interface ChatInputAddMenuProps {
  onAddContext: () => void;
  onAttach: () => void;
  onWhisperToggle: () => void;
  onGameClick: () => void;
  onClose: () => void;
  messageDisposition: MessageDispositionPreferenceController;
  triggerRef?: RefObject<HTMLElement | null>;
  disabled?: boolean;
  sendDisabled?: boolean;
  maxImages?: boolean;
  whisperMode?: boolean;
}

export function ChatInputAddMenu({
  onAddContext,
  onAttach,
  onWhisperToggle,
  onGameClick,
  onClose,
  messageDisposition,
  triggerRef,
  disabled,
  sendDisabled,
  maxImages,
  whisperMode,
}: ChatInputAddMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<'root' | 'disposition'>('root');

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef?.current?.contains(target)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose, triggerRef]);

  const unavailable = Boolean(disabled || sendDisabled);

  return (
    <div
      ref={menuRef}
      id="composer-add-menu"
      data-testid="composer-add-menu"
      role="menu"
      aria-label="添加内容"
      className="absolute bottom-full left-4 z-20 mb-2 w-[min(19rem,calc(100vw-2rem))] overflow-hidden rounded-2xl bg-cafe-surface-canvas p-1.5 shadow-xl"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {view === 'disposition' ? (
        <MessageDispositionSelector controller={messageDisposition} onBack={() => setView('root')} />
      ) : (
        <div>
          <AddMenuItem
            testId="composer-add-context"
            icon={<ContextIcon />}
            label="引用 Thread 或文件"
            description="把家里的已有内容带进这条消息"
            disabled={unavailable}
            onClick={() => {
              onClose();
              onAddContext();
            }}
          />
          <AddMenuItem
            testId="composer-upload"
            icon={<AttachIcon className="h-5 w-5" />}
            label="上传附件"
            description="图片、文档或压缩包，最多 5 个"
            disabled={unavailable || maxImages}
            onClick={() => {
              onClose();
              onAttach();
            }}
          />
          <AddMenuItem
            testId="message-disposition-trigger"
            dataDispositionSource={messageDisposition.source}
            icon={<StrategyIcon />}
            label="发送策略"
            description={messageDispositionLabel(messageDisposition.effective)}
            disabled={disabled}
            onClick={() => setView('disposition')}
          />
          <AddMenuItem
            testId="composer-whisper"
            icon={<WhisperIcon />}
            label="悄悄话"
            description={whisperMode ? '已开启；选择猫猫或点此关闭' : '只让选中的猫猫看见'}
            active={whisperMode}
            disabled={unavailable}
            onClick={() => {
              onClose();
              onWhisperToggle();
            }}
          />
          <AddMenuItem
            testId="composer-game"
            icon={<GameIcon />}
            label="游戏"
            description="选择游戏与参与方式"
            disabled={unavailable}
            onClick={() => {
              onClose();
              onGameClick();
            }}
          />
        </div>
      )}
    </div>
  );
}

function AddMenuItem({
  testId,
  dataDispositionSource,
  icon,
  label,
  description,
  active,
  disabled,
  onClick,
}: {
  testId: string;
  dataDispositionSource?: string;
  icon: React.ReactNode;
  label: string;
  description: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      data-disposition-source={dataDispositionSource}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
        active ? 'bg-accent-50 text-cafe-accent' : 'text-cafe-secondary hover:bg-cafe-surface-sunken'
      }`}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cafe-surface text-cafe-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-cafe-muted">{description}</span>
      </span>
    </button>
  );
}

function StrategyIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M4 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 1a1 1 0 0 0 0 2h6a1 1 0 1 0 0-2h-6ZM4 12a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 1a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-6Z" />
    </svg>
  );
}

function ContextIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M4 3a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2v3l4-3h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4Z" />
    </svg>
  );
}

function WhisperIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M5 9V7a5 5 0 0 1 10 0v2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Zm8-2v2H7V7a3 3 0 0 1 6 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
