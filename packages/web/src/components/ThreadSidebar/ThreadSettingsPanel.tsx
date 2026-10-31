'use client';

import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CafeIcon } from '@/components/rich/CafeIcons';
import { ThreadBackgroundDetail, ThreadBackgroundSettings } from '../chat-background/ThreadBackgroundSettings';
import { useThreadSettingsPosition } from '../chat-background/useThreadSettingsPosition';
import { useShellCopy } from '../shell/shell-copy';
import { useShellPresentation } from '../shell/shell-presentation';
import { threadSettingsCopy } from '../shell/thread-settings.shell-copy';
import { ThreadCatSettingsContent } from './ThreadCatSettings';
import { ThreadEffortSettingsContent } from './ThreadEffortSettings';
import { ThreadFeatureSettingsContent } from './ThreadFeatureSettings';
import { ThreadGoalSettingsContent } from './ThreadGoalSettings';
import { ThreadLabelSettingsContent } from './ThreadLabelPicker';
import { ThreadNativeStatusSettingsContent } from './ThreadNativeStatusSettings';
import { ThreadSpeedSettingsContent } from './ThreadSpeedSettings';
import { threadSignalsCopy } from './thread-signals.shell-copy';

type SettingsSectionId = 'goal' | 'status' | 'cats' | 'effort' | 'speed' | 'labels' | 'feature' | 'background';

interface ThreadSettingsPanelProps {
  open: boolean;
  threadId: string;
  threadTitle: string;
  projectPath?: string;
  currentCats: string[];
  currentLabels: string[];
  onSavePreferredCats?: (threadId: string, cats: string[]) => void | Promise<void>;
  onSaveLabels?: (threadId: string, labels: string[]) => void | Promise<void>;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  pinned?: boolean;
  onTogglePin?: () => Promise<boolean>;
}

export function ThreadSettingsPanel({
  open,
  threadId,
  threadTitle,
  projectPath,
  currentCats,
  currentLabels,
  onSavePreferredCats,
  onSaveLabels,
  onClose,
  returnFocusRef,
  pinned,
  onTogglePin,
}: ThreadSettingsPanelProps) {
  const copy = useShellCopy(threadSignalsCopy);
  const isV2 = useShellPresentation() === 'v2';
  const localized = useShellCopy(threadSettingsCopy);
  const settingsCopy = isV2 ? localized : threadSettingsCopy.zh;
  const panelRef = useRef<HTMLElement>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionId | null>(null);
  const wasBackground = useRef(false);
  const panelId = `thread-settings-${threadId}`;
  const position = useThreadSettingsPosition(open, isV2, returnFocusRef);

  useEffect(() => {
    if (!open) setActiveSection(null);
  }, [open]);

  useEffect(() => {
    if (open && isV2 && (activeSection === 'background' || wasBackground.current)) {
      const selector =
        activeSection === 'background' ? '[data-background-back]' : '[data-testid="thread-background-entry"]';
      panelRef.current?.querySelector<HTMLButtonElement>(selector)?.focus();
    }
    wasBackground.current = activeSection === 'background';
  }, [open, isV2, activeSection]);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      // The controlling button owns its toggle; an outside-close here would race its subsequent click.
      const trigger = event.target instanceof Element ? event.target.closest('button[aria-controls]') : null;
      if (isV2 && trigger?.getAttribute('aria-controls') === panelId) return;
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
  }, [open, onClose, returnFocusRef, isV2, panelId]);

  if (!open || typeof document === 'undefined') return null;

  const toggleSection = (section: SettingsSectionId) => {
    setActiveSection((current) => (current === section ? null : section));
  };

  const runtimeStatus = (
    <SettingsSection
      id="status"
      title={settingsCopy.status}
      description={settingsCopy.statusDescription}
      icon={isV2 ? 'chart' : 'activity'}
      active={activeSection === 'status'}
      onToggle={() => toggleSection('status')}
    >
      <ThreadNativeStatusSettingsContent threadId={threadId} />
    </SettingsSection>
  );

  return createPortal(
    <aside
      id={panelId}
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`thread-settings-title-${threadId}`}
      data-thread-settings-panel="true"
      data-testid="thread-settings-panel"
      className={
        isV2
          ? 'thread-settings-popover'
          : 'fixed inset-x-2 bottom-2 z-[60] flex max-h-[78vh] flex-col overflow-hidden rounded-2xl border border-cafe bg-cafe-surface shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[400px] md:rounded-none md:border-y-0 md:border-r-0'
      }
      style={position}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header
        className={`flex flex-shrink-0 items-start gap-3 border-b border-cafe-subtle px-4 py-3.5 ${activeSection === 'background' ? 'sr-only' : ''}`}
      >
        <div className="min-w-0 flex-1">
          <h2 id={`thread-settings-title-${threadId}`} className="text-sm font-semibold text-cafe-black">
            {settingsCopy.title}
          </h2>
          <p className="mt-0.5 truncate text-micro text-cafe-muted" title={threadTitle}>
            {threadTitle}
          </p>
        </div>
        {activeSection !== 'background' && (
          <button
            type="button"
            aria-label={settingsCopy.close}
            onClick={() => {
              onClose();
              returnFocusRef?.current?.focus();
            }}
            className="rounded-lg p-1 text-cafe-muted transition-colors hover:bg-cafe-surface-elevated hover:text-cafe-secondary"
          >
            <CafeIcon name="cross" className="h-4 w-4" />
          </button>
        )}
      </header>

      {activeSection === 'background' ? (
        <div className="min-h-0 overflow-y-auto">
          <ThreadBackgroundDetail threadId={threadId} onBack={() => setActiveSection(null)} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {isV2 && (
            <ThreadBackgroundSettings
              threadId={threadId}
              pinned={pinned}
              onTogglePin={onTogglePin}
              onOpen={() => setActiveSection('background')}
            />
          )}
          {projectPath && projectPath !== 'default' && (
            <div data-testid="thread-project-path" className="mb-2 rounded-xl border border-cafe-subtle px-3 py-2">
              <p className="text-micro text-cafe-muted">{copy.projectPath}</p>
              <p className="mt-1 break-all text-xs text-cafe-secondary">{projectPath}</p>
            </div>
          )}
          <SettingsGroup id="goal" title={settingsCopy.goalGroup} grouped={isV2}>
            <SettingsSection
              id="goal"
              title={settingsCopy.goal}
              description={settingsCopy.goalDescription}
              icon="target"
              active={activeSection === 'goal'}
              onToggle={() => toggleSection('goal')}
            >
              <ThreadGoalSettingsContent threadId={threadId} />
            </SettingsSection>
          </SettingsGroup>
          <SettingsGroup id="execution" title={settingsCopy.executionGroup} grouped={isV2}>
            {!isV2 && runtimeStatus}
            {onSavePreferredCats && (
              <SettingsSection
                id="cats"
                title={settingsCopy.cats}
                description={settingsCopy.catsDescription}
                icon="chat"
                active={activeSection === 'cats'}
                onToggle={() => toggleSection('cats')}
              >
                <ThreadCatSettingsContent threadId={threadId} currentCats={currentCats} onSave={onSavePreferredCats} />
              </SettingsSection>
            )}
            <SettingsSection
              id="effort"
              title={settingsCopy.effort}
              description={settingsCopy.effortDescription}
              icon="idea"
              active={activeSection === 'effort'}
              onToggle={() => toggleSection('effort')}
            >
              <ThreadEffortSettingsContent threadId={threadId} />
            </SettingsSection>
            <SettingsSection
              id="speed"
              title={settingsCopy.speed}
              description={settingsCopy.speedDescription}
              icon="bolt"
              active={activeSection === 'speed'}
              onToggle={() => toggleSection('speed')}
            >
              <ThreadSpeedSettingsContent threadId={threadId} />
            </SettingsSection>
            {isV2 && runtimeStatus}
          </SettingsGroup>
          <SettingsGroup id="organization" title={settingsCopy.organizationGroup} grouped={isV2}>
            {onSaveLabels && (
              <SettingsSection
                id="labels"
                title={settingsCopy.labels}
                description={settingsCopy.labelsDescription}
                icon="tree"
                active={activeSection === 'labels'}
                onToggle={() => toggleSection('labels')}
              >
                <ThreadLabelSettingsContent threadId={threadId} currentLabels={currentLabels} onSave={onSaveLabels} />
              </SettingsSection>
            )}
            {isV2 && (
              <SettingsSection
                id="feature"
                title={settingsCopy.feature}
                description={settingsCopy.featureDescription}
                icon="code"
                active={activeSection === 'feature'}
                onToggle={() => toggleSection('feature')}
              >
                <ThreadFeatureSettingsContent threadId={threadId} />
              </SettingsSection>
            )}
          </SettingsGroup>
        </div>
      )}
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

function SettingsGroup({
  id,
  title,
  grouped,
  children,
}: {
  id: string;
  title: string;
  grouped: boolean;
  children: ReactNode;
}) {
  if (!grouped) return <>{children}</>;
  return (
    <div data-settings-group={id} className="mb-3 last:mb-0">
      <h3 className="px-3 py-2 text-micro font-semibold text-cafe-muted">{title}</h3>
      {children}
    </div>
  );
}
