'use client';

import type { CollectiveCafeSection } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useOpenInChat } from '@/components/shell/use-open-in-chat';
import { useChatStore } from '@/stores/chatStore';
import { CollectiveCafeSectionContent } from './CollectiveCafeSectionContent';
import type { CollectiveConnectionProjection } from './collective-client';
import type { useCollectiveParticipation } from './use-collective-participation';
import type { CollectiveWorkPolicyState } from './use-collective-work-policy';

function sectionTitle(section: CollectiveCafeSection, channelId: string) {
  if (section === 'channel') return `# ${channelId}`;
  return (
    {
      cats: '我的猫',
      calendar: '日程',
      permissions: '已允许的工作',
      connection: '连接设置',
    } as const
  )[section];
}

export function CollectiveCafePanel({
  state,
  connection,
  channelId,
  channels,
  busy,
  pairingState,
  onClose,
  onOpenMembers,
  onPair,
  onMutate,
  connections,
  onSelectConnection,
  workPolicy,
  initialSection = 'cats',
}: {
  readonly workPolicy?: CollectiveWorkPolicyState;
  readonly initialSection?: CollectiveCafeSection;
  readonly state: ReturnType<typeof useCollectiveParticipation>;
  readonly connection: CollectiveConnectionProjection;
  readonly channelId: string;
  readonly channels: readonly string[];
  readonly busy?: string;
  readonly pairingState: 'waiting' | 'ready' | 'unavailable';
  readonly onClose: () => void;
  readonly onOpenMembers?: () => void;
  readonly onPair: () => void;
  readonly onMutate: (operation: 'reconnect' | 'revoke') => void;
  readonly connections: readonly CollectiveConnectionProjection[];
  readonly onSelectConnection: (id: string) => void;
}) {
  const openInChat = useOpenInChat();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [section, setSection] = useState<CollectiveCafeSection>(initialSection);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <aside
      aria-label="我的 Café"
      className="absolute inset-y-0 right-0 z-20 flex collective-private-page flex-col border-l border-[var(--console-border-soft)] bg-[var(--shell-work)] text-cafe-primary "
    >
      <header className="flex items-center justify-between border-b border-[var(--console-border-soft)] px-5 py-4">
        <div>
          <p className="text-micro text-cafe-muted">我的 Café · 仅自己可见</p>
          <h2 className="mt-1 text-lg font-semibold">{sectionTitle(section, channelId)}</h2>
        </div>
        <button
          ref={closeButton}
          type="button"
          aria-label="返回共同体"
          className="px-2 text-2xl text-cafe-muted"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {section === 'calendar' && (
          <button
            type="button"
            className="mb-5 rounded-lg border border-[var(--shell-hairline-strong)] px-3 py-2 text-sm"
            onClick={() => {
              onClose();
              openInChat(() => useChatStore.getState().setWorkspaceMode('product-schedule'));
            }}
          >
            打开家里的待办与日程
          </button>
        )}
        <CollectiveCafeSectionContent
          section={section}
          state={state}
          workPolicy={workPolicy}
          connection={connection}
          connections={connections}
          channelId={channelId}
          channels={channels}
          busy={busy}
          pairingState={pairingState}
          onPair={onPair}
          onMutate={onMutate}
          onSelectConnection={onSelectConnection}
          onSelectCats={onOpenMembers ?? (() => setSection('cats'))}
        />
      </div>
    </aside>
  );
}
