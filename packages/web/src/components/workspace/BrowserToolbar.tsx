'use client';

import { useIMEGuard } from '@/hooks/useIMEGuard';

interface BrowserToolbarProps {
  urlInput: string;
  onUrlChange: (value: string) => void;
  onNavigate: () => void;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onScreenshot: () => void;
  isCapturing: boolean;
  hasTarget: boolean;
  consoleOpen: boolean;
  onConsoleToggle: () => void;
  consoleCount: number;
}

export function BrowserToolbar({
  urlInput,
  onUrlChange,
  onNavigate,
  onBack,
  onForward,
  onRefresh,
  onScreenshot,
  isCapturing,
  hasTarget,
  consoleOpen,
  onConsoleToggle,
  consoleCount,
}: BrowserToolbarProps) {
  const ime = useIMEGuard();
  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--console-border-soft)]">
      <button
        type="button"
        onClick={onBack}
        className="p-1 rounded hover:bg-[var(--console-hover-bg)] text-cafe-muted text-sm"
        title="Back"
      >
        ‹
      </button>
      <button
        type="button"
        onClick={onForward}
        className="p-1 rounded hover:bg-[var(--console-hover-bg)] text-cafe-muted text-sm"
        title="Forward"
      >
        ›
      </button>
      <button
        type="button"
        onClick={onRefresh}
        className="p-1 rounded hover:bg-[var(--console-hover-bg)] text-cafe-muted text-sm"
        title="Refresh"
      >
        ↻
      </button>

      <div className="flex-1 flex items-center">
        <input
          type="text"
          value={urlInput}
          onChange={(e) => onUrlChange(e.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !ime.isComposing()) onNavigate();
          }}
          placeholder="localhost:3000"
          className="console-form-input w-full text-xs"
        />
      </div>

      <button type="button" onClick={onNavigate} className="console-button-primary px-2.5 py-1 text-xs">
        Go
      </button>

      <button
        type="button"
        onClick={onScreenshot}
        disabled={isCapturing || !hasTarget}
        className="p-1 rounded hover:bg-[var(--console-hover-bg)] text-cafe-muted text-sm disabled:opacity-30"
        title="Capture Screenshot"
      >
        {isCapturing ? '...' : '📷'}
      </button>

      <button
        type="button"
        onClick={onConsoleToggle}
        className={`p-1 rounded text-sm transition-colors ${
          consoleOpen
            ? 'bg-[var(--console-active-bg)] text-cafe-accent'
            : 'hover:bg-[var(--console-hover-bg)] text-cafe-muted'
        }`}
        title="Toggle Console"
      >
        {consoleCount > 0 ? `⌥${consoleCount}` : '⌥'}
      </button>
    </div>
  );
}
