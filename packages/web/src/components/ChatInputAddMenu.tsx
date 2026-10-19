'use client';

import { type RefObject, useState } from 'react';
import type { MessageDispositionPreferenceController } from '@/hooks/useMessageDispositionPreference';
import { AppTooltip } from './AppTooltip';
import { ComposerPopover } from './ComposerPopover';
import { type ComposerPreferredCatControl, ComposerPreferredCatSection } from './ComposerPreferredCatSection';
import { chatComposerCopy } from './chat-composer.shell-copy';
import { AttachIcon } from './icons/AttachIcon';
import { MessageDispositionSelector, messageDispositionLabel } from './MessageDispositionSelector';
import { useShellCopy } from './shell/shell-copy';

interface ChatInputAddMenuProps {
  presentation?: 'classic' | 'v2';
  onAddContext: () => void;
  onAttach: () => void;
  onWhisperToggle: () => void;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement>;
  disabled?: boolean;
  sendDisabled?: boolean;
  maxImages?: boolean;
  whisperMode?: boolean;
  messageDisposition?: MessageDispositionPreferenceController;
  hasActiveInvocation?: boolean;
  preferredCat?: ComposerPreferredCatControl;
}

export function ChatInputAddMenu({
  presentation = 'classic',
  onAddContext,
  onAttach,
  onWhisperToggle,
  onClose,
  triggerRef,
  disabled,
  sendDisabled,
  maxImages,
  whisperMode,
  messageDisposition,
  hasActiveInvocation = false,
  preferredCat,
}: ChatInputAddMenuProps) {
  const [view, setView] = useState<'root' | 'disposition'>('root');
  const localized = useShellCopy(chatComposerCopy);
  const t = presentation === 'v2' ? localized : chatComposerCopy.zh;

  const unavailable = Boolean(disabled || sendDisabled);

  return (
    <ComposerPopover
      anchor={triggerRef}
      label={t.addContent}
      onClose={onClose}
      preferredWidth={304}
      presentation={presentation}
    >
      <div id="composer-add-menu" data-testid="composer-add-menu" className="bg-cafe-surface-canvas">
        {view === 'disposition' && messageDisposition ? (
          <MessageDispositionSelector controller={messageDisposition} onBack={() => setView('root')} />
        ) : (
          <div role="menu" aria-label={t.addContent} className="w-full overflow-hidden rounded-lg">
            {presentation === 'v2' && hasActiveInvocation && messageDisposition ? (
              <AddMenuItem
                testId="message-disposition-trigger"
                dispositionSource={messageDisposition.source}
                label={`这条发出去后：${messageDispositionLabel(messageDisposition.effective)}`}
                description="只影响这条消息"
                icon={<span aria-hidden>↪</span>}
                disabled={messageDisposition.loading}
                onClick={() => setView('disposition')}
              />
            ) : null}
            {presentation === 'v2' && preferredCat ? <ComposerPreferredCatSection {...preferredCat} /> : null}
            {presentation === 'v2' ? (
              <div className="border-b border-cafe-subtle px-3 py-2 text-xs font-medium text-cafe-muted">{t.add}</div>
            ) : null}
            <div className={presentation === 'v2' ? 'p-1.5' : undefined}>
              <AddMenuItem
                tooltip={presentation === 'v2'}
                testId="composer-add-context"
                icon={<ContextIcon />}
                label={presentation === 'v2' ? t.context : '引用 Thread 或文件'}
                description={t.contextHint}
                disabled={unavailable}
                onClick={() => {
                  onClose();
                  onAddContext();
                }}
              />
              <AddMenuItem
                tooltip={presentation === 'v2'}
                testId="composer-upload"
                icon={<AttachIcon className="h-5 w-5" />}
                label={t.upload}
                description={t.uploadHint}
                disabled={unavailable || maxImages}
                onClick={() => {
                  onClose();
                  onAttach();
                }}
              />
              {presentation === 'classic' && hasActiveInvocation && messageDisposition ? (
                <AddMenuItem
                  testId="message-disposition-trigger"
                  dispositionSource={messageDisposition.source}
                  label="这条发出去后"
                  description={messageDispositionLabel(messageDisposition.effective)}
                  icon={<StrategyIcon />}
                  disabled={messageDisposition.loading}
                  onClick={() => setView('disposition')}
                />
              ) : null}
            </div>
            <div className={presentation === 'v2' ? 'border-t border-cafe-subtle p-1.5' : undefined}>
              <AddMenuItem
                tooltip={presentation === 'v2'}
                testId="composer-whisper"
                icon={<WhisperIcon />}
                label={t.whisper}
                description={whisperMode ? t.whisperActiveHint : t.whisperHint}
                active={whisperMode}
                disabled={unavailable}
                onClick={() => {
                  onClose();
                  onWhisperToggle();
                }}
              />
            </div>
          </div>
        )}
      </div>
    </ComposerPopover>
  );
}

function AddMenuItem({
  tooltip = false,
  testId,
  dispositionSource,
  icon,
  label,
  description,
  active,
  disabled,
  onClick,
}: {
  tooltip?: boolean;
  testId: string;
  dispositionSource?: string;
  icon: React.ReactNode;
  label: string;
  description: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <AppTooltip label={label} detail={description} side="top" multiline disabled={!tooltip}>
      <button
        type="button"
        role="menuitem"
        data-testid={testId}
        data-disposition-source={dispositionSource}
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
    </AppTooltip>
  );
}

function ContextIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M4 3a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2v3l4-3h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4Z" />
    </svg>
  );
}

function StrategyIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M4 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 1a1 1 0 0 0 0 2h6a1 1 0 1 0 0-2h-6ZM4 12a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 1a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-6Z" />
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
