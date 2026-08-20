'use client';

import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CafeIcon } from '@/components/rich/CafeIcons';
import { ThreadCatSettingsContent } from './ThreadCatSettings';
import { ThreadEffortSettingsContent } from './ThreadEffortSettings';
import { ThreadLabelSettingsContent } from './ThreadLabelPicker';
import { ThreadSpeedSettingsContent } from './ThreadSpeedSettings';

type SettingsSectionId = 'cats' | 'effort' | 'speed' | 'labels';

interface ThreadSettingsPanelProps {
  open: boolean;
  threadId: string;
  threadTitle: string;
  currentCats: string[];
  currentLabels: string[];
  onSavePreferredCats?: (threadId: string, cats: string[]) => void | Promise<void>;
  onSaveLabels?: (threadId: string, labels: string[]) => void | Promise<void>;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function ThreadSettingsPanel({
  open,
  threadId,
  threadTitle,
  currentCats,
  currentLabels,
  onSavePreferredCats,
  onSaveLabels,
  onClose,
  returnFocusRef,
}: ThreadSettingsPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionId | null>(null);

  useEffect(() => {
    if (!open) setActiveSection(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      onClose();
      returnFocusRef?.current?.focus();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose, returnFocusRef]);

  if (!open || typeof document === 'undefined') return null;

  const toggleSection = (section: SettingsSectionId) => {
    setActiveSection((current) => (current === section ? null : section));
  };

  return createPortal(
    <aside
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`thread-settings-title-${threadId}`}
      data-thread-settings-panel="true"
      data-testid="thread-settings-panel"
      className="fixed inset-x-2 bottom-2 z-[60] flex max-h-[78vh] flex-col overflow-hidden rounded-2xl border border-cafe bg-cafe-surface shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[400px] md:rounded-none md:border-y-0 md:border-r-0"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header className="flex flex-shrink-0 items-start gap-3 border-b border-cafe-subtle px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 id={`thread-settings-title-${threadId}`} className="text-sm font-semibold text-cafe-black">
            对话设置
          </h2>
          <p className="mt-0.5 truncate text-micro text-cafe-muted" title={threadTitle}>
            {threadTitle}
          </p>
        </div>
        <button
          type="button"
          aria-label="关闭对话设置"
          onClick={() => {
            onClose();
            returnFocusRef?.current?.focus();
          }}
          className="rounded-lg p-1 text-cafe-muted transition-colors hover:bg-cafe-surface-elevated hover:text-cafe-secondary"
        >
          <CafeIcon name="cross" className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {onSavePreferredCats && (
          <SettingsSection
            id="cats"
            title="默认猫猫"
            description="决定没有显式 @ 时谁优先回复"
            icon="chat"
            active={activeSection === 'cats'}
            onToggle={() => toggleSection('cats')}
          >
            <ThreadCatSettingsContent threadId={threadId} currentCats={currentCats} onSave={onSavePreferredCats} />
          </SettingsSection>
        )}
        <SettingsSection
          id="effort"
          title="思考档位"
          description="按猫覆盖本对话的思考深度"
          icon="idea"
          active={activeSection === 'effort'}
          onToggle={() => toggleSection('effort')}
        >
          <ThreadEffortSettingsContent threadId={threadId} />
        </SettingsSection>
        <SettingsSection
          id="speed"
          title="速度档位"
          description="为 Codex OAuth 猫选择 Standard / Fast"
          icon="bolt"
          active={activeSection === 'speed'}
          onToggle={() => toggleSection('speed')}
        >
          <ThreadSpeedSettingsContent threadId={threadId} />
        </SettingsSection>
        {onSaveLabels && (
          <SettingsSection
            id="labels"
            title="标签管理"
            description="整理与筛选这条对话"
            icon="tree"
            active={activeSection === 'labels'}
            onToggle={() => toggleSection('labels')}
          >
            <ThreadLabelSettingsContent threadId={threadId} currentLabels={currentLabels} onSave={onSaveLabels} />
          </SettingsSection>
        )}
      </div>
    </aside>,
    document.body,
  );
}

function SettingsSection({
  id,
  title,
  description,
  icon,
  active,
  onToggle,
  children,
}: {
  id: SettingsSectionId;
  title: string;
  description: string;
  icon: string;
  active: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const contentId = `thread-settings-section-${id}`;
  return (
    <section className="mb-1 overflow-hidden rounded-xl border border-cafe-subtle last:mb-0">
      <button
        type="button"
        aria-expanded={active}
        aria-controls={contentId}
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-cafe-surface-elevated"
      >
        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-cafe-surface-elevated text-cafe-accent">
          <CafeIcon name={icon} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-cafe-black">{title}</span>
          <span className="mt-0.5 block text-micro text-cafe-muted">{description}</span>
        </span>
        <ChevronIcon expanded={active} />
      </button>
      {active && (
        <div id={contentId} className="border-t border-cafe-subtle bg-cafe-bg/40">
          {children}
        </div>
      )}
    </section>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`h-4 w-4 flex-shrink-0 text-cafe-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}
