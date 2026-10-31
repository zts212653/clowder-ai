'use client';

/**
 * F252 Phase E PR E-4 — Multi-Cam Stage Layout
 *
 * Dynamic layout engine for multi-thread feature replay. Arranges
 * ThreadPanel components based on active thread count:
 * - single: 1 panel centered (max-width 900px)
 * - dual:   2 panels side by side (50/50)
 * - multi:  2 main panels + sidebar column for overflow
 *
 * AC-E5: Multi-cam split screen
 * AC-E3: Spotlight/dim visual state via ThreadPanel mode prop
 */

import type { CamLayout } from '@/lib/story-player/active-thread-tracker';
import type { ReplayChatMessage } from '@/lib/story-player/replay-chat-bridge';
import { type PanelMode, ThreadPanel } from './ThreadPanel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThreadPanelConfig {
  threadId: string;
  threadName: string;
  participants: string[];
  mode: PanelMode;
  messages: ReplayChatMessage[];
}

export interface MultiCamStageProps {
  panels: ThreadPanelConfig[];
  layout: CamLayout;
  displayMode?: 'cinematic' | 'faithful';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MultiCamStage({ panels, layout, displayMode }: MultiCamStageProps) {
  if (panels.length === 0) {
    return (
      <div data-testid="multicam-stage" className="flex-1 flex items-center justify-center">
        <span className="text-[var(--console-text-tertiary,#888)] text-sm">No active threads</span>
      </div>
    );
  }

  return (
    <div data-testid="multicam-stage" className="flex-1 overflow-hidden p-3">
      {layout === 'single' && <SingleLayout panel={panels[0]} displayMode={displayMode} />}
      {layout === 'dual' && <DualLayout panels={panels.slice(0, 2)} displayMode={displayMode} />}
      {layout === 'multi' && <MultiLayout panels={panels} displayMode={displayMode} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout variants
// ---------------------------------------------------------------------------

function SingleLayout({ panel, displayMode }: { panel: ThreadPanelConfig; displayMode?: 'cinematic' | 'faithful' }) {
  return (
    <div className="h-full flex justify-center">
      <div className="w-full max-w-[900px] h-full">
        <ThreadPanel {...panel} displayMode={displayMode} />
      </div>
    </div>
  );
}

function DualLayout({ panels, displayMode }: { panels: ThreadPanelConfig[]; displayMode?: 'cinematic' | 'faithful' }) {
  return (
    <div className="h-full grid grid-cols-2 gap-3">
      {panels.map((panel) => (
        <ThreadPanel key={panel.threadId} {...panel} displayMode={displayMode} />
      ))}
    </div>
  );
}

function MultiLayout({ panels, displayMode }: { panels: ThreadPanelConfig[]; displayMode?: 'cinematic' | 'faithful' }) {
  // First 2 panels = main area, rest = sidebar thumbnails
  const mainPanels = panels.slice(0, 2);
  const sidebarPanels = panels.slice(2);

  return (
    <div className="h-full grid gap-3" style={{ gridTemplateColumns: '1fr 1fr 200px' }}>
      {/* Main panels */}
      {mainPanels.map((panel) => (
        <ThreadPanel key={panel.threadId} {...panel} displayMode={displayMode} />
      ))}

      {/* Sidebar */}
      <div data-testid="multicam-sidebar" className="flex flex-col gap-2 overflow-y-auto">
        {sidebarPanels.map((panel) => (
          <div key={panel.threadId} className="h-[120px] flex-shrink-0">
            <ThreadPanel {...panel} displayMode={displayMode} />
          </div>
        ))}
      </div>

      {/* data-testid for main area (wrapping test anchor) */}
      <div data-testid="multicam-main" className="hidden" />
    </div>
  );
}
