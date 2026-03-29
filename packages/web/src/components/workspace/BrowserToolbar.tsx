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
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[#FFDDD2] bg-cafe-surface/60">
      <button
        type="button"
        onClick={onBack}
        className="p-1 rounded hover:bg-[#FFF5F2] text-[#5a4a42]/60 text-sm"
        title="Back"
      >
        ‹
      </button>
      <button
        type="button"
        onClick={onForward}
        className="p-1 rounded hover:bg-[#FFF5F2] text-[#5a4a42]/60 text-sm"
        title="Forward"
      >
        ›
      </button>
      <button
        type="button"
        onClick={onRefresh}
        className="p-1 rounded hover:bg-[#FFF5F2] text-[#5a4a42]/60 text-sm"
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
          className="w-full px-2 py-1 text-xs rounded border border-[#FFDDD2] bg-cafe-surface focus:outline-none focus:border-[#E29578] placeholder:text-[#5a4a42]/30"
        />
      </div>

      <button
        type="button"
        onClick={onNavigate}
        className="px-2.5 py-1 text-xs rounded bg-[#E29578] text-white hover:bg-[#d4856a] transition-colors"
      >
        Go
      </button>

      <button
        type="button"
        onClick={onScreenshot}
        disabled={isCapturing || !hasTarget}
        className="p-1 rounded hover:bg-[#FFF5F2] text-[#5a4a42]/60 text-sm disabled:opacity-30"
        title="Capture Screenshot"
      >
        {isCapturing ? '...' : '📷'}
      </button>

      <button
        type="button"
        onClick={onConsoleToggle}
        className={`p-1 rounded text-sm transition-colors ${
          consoleOpen ? 'bg-[#E29578]/20 text-[#E29578]' : 'hover:bg-[#FFF5F2] text-[#5a4a42]/60'
        }`}
        title="Toggle Console"
      >
        {consoleCount > 0 ? `⌥${consoleCount}` : '⌥'}
      </button>
    </div>
  );
}
