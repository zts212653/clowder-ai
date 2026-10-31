'use client';

import { useIMEGuard } from '@/hooks/useIMEGuard';

interface BrowserToolbarCopy {
  back: string;
  forward: string;
  refresh: string;
  go: string;
  screenshot: string;
  consoleToggle: string;
}

const DEFAULT_COPY: BrowserToolbarCopy = {
  back: 'Back',
  forward: 'Forward',
  refresh: 'Refresh',
  go: 'Go',
  screenshot: 'Capture Screenshot',
  consoleToggle: 'Toggle Console',
};

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
  /** F322: wording from the panel's presentation; defaults to the classic literals. */
  copy?: BrowserToolbarCopy;
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
  copy = DEFAULT_COPY,
}: BrowserToolbarProps) {
  const ime = useIMEGuard();
  return (
    <div className="flex items-center gap-1 px-2 py-1.5 console-divider-b bg-cafe-surface/60">
      <button
        type="button"
        onClick={onBack}
        className="p-1 rounded hover:bg-[var(--ws-surface-hover)] text-[var(--ws-text)]/60 text-sm"
        title={copy.back}
      >
        ‹
      </button>
      <button
        type="button"
        onClick={onForward}
        className="p-1 rounded hover:bg-[var(--ws-surface-hover)] text-[var(--ws-text)]/60 text-sm"
        title={copy.forward}
      >
        ›
      </button>
      <button
        type="button"
        onClick={onRefresh}
        className="p-1 rounded hover:bg-[var(--ws-surface-hover)] text-[var(--ws-text)]/60 text-sm"
        title={copy.refresh}
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
          className="w-full px-2 py-1 text-xs rounded border border-[var(--console-border-soft)] bg-cafe-surface focus:outline-none focus:border-[var(--ws-accent)] placeholder:text-[var(--ws-text)]/30"
        />
      </div>

      <button
        type="button"
        onClick={onNavigate}
        className="px-2.5 py-1 text-xs rounded bg-[var(--ws-accent)] text-[var(--cafe-surface)] hover:bg-[var(--ws-accent-hover)] transition-colors"
      >
        {copy.go}
      </button>

      <button
        type="button"
        onClick={onScreenshot}
        disabled={isCapturing || !hasTarget}
        className="p-1 rounded hover:bg-[var(--ws-surface-hover)] text-[var(--ws-text)]/60 text-sm disabled:opacity-30"
        title={copy.screenshot}
      >
        {isCapturing ? '...' : '📷'}
      </button>

      <button
        type="button"
        onClick={onConsoleToggle}
        className={`p-1 rounded text-sm transition-colors ${
          consoleOpen
            ? 'bg-[var(--ws-accent)]/20 text-[var(--ws-accent)]'
            : 'hover:bg-[var(--ws-surface-hover)] text-[var(--ws-text)]/60'
        }`}
        title={copy.consoleToggle}
      >
        {consoleCount > 0 ? `⌥${consoleCount}` : '⌥'}
      </button>
    </div>
  );
}
