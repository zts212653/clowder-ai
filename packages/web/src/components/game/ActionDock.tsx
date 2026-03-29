'use client';

import { useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';

interface ActionDockProps {
  onVote: () => void;
  onSpeak: (content: string) => void;
  disabled?: boolean;
}

export function ActionDock({ onVote, onSpeak, disabled = false }: ActionDockProps) {
  const [input, setInput] = useState('');
  const ime = useIMEGuard();

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    onSpeak(trimmed);
    setInput('');
  };

  return (
    <div data-testid="action-dock" className="flex items-center gap-3 bg-ww-topbar px-6 py-2 h-14 w-full">
      <button
        type="button"
        data-testid="vote-btn"
        onClick={onVote}
        disabled={disabled}
        className="flex items-center gap-1.5 bg-ww-danger text-ww-main font-bold text-sm rounded-lg px-5 py-2.5 shrink-0 disabled:opacity-50"
      >
        投票
      </button>
      <input
        data-testid="speak-input"
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !ime.isComposing()) handleSend();
        }}
        placeholder="输入发言内容..."
        disabled={disabled}
        className="flex-1 bg-ww-surface text-ww-main rounded-lg px-3.5 h-[38px] text-sm placeholder:text-ww-dim outline-none disabled:opacity-50"
      />
      <button
        type="button"
        data-testid="send-btn"
        onClick={handleSend}
        disabled={disabled || !input.trim()}
        className="bg-ww-card text-ww-muted font-semibold text-sm rounded-lg px-4 py-2.5 shrink-0 disabled:opacity-50"
      >
        发送
      </button>
    </div>
  );
}
