'use client';

import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { useInputHistoryStore } from '@/stores/inputHistoryStore';

interface HistorySearchModalProps {
  onSelect: (text: string) => void;
  onClose: () => void;
}

export function HistorySearchModal({ onSelect, onClose }: HistorySearchModalProps) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const search = useInputHistoryStore((s) => s.search);
  const ime = useIMEGuard();

  const results = query ? search(query) : useInputHistoryStore.getState().entries.slice(0, 20);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIdx(0);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && results.length > 0 && !ime.isComposing()) {
        e.preventDefault();
        onSelect(results[selectedIdx]);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ime.isComposing() reads a live ref; adding ime would cause unnecessary re-renders
    [results, selectedIdx, onSelect, onClose],
  );

  return (
    <div
      data-testid="history-search"
      className="absolute bottom-full left-0 right-0 mb-1 mx-4 bg-cafe-surface rounded-xl shadow-lg border border-cafe overflow-hidden z-20"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-cafe-subtle">
        <span className="text-xs text-cafe-muted font-mono">Ctrl+R</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          placeholder="Search history..."
          className="flex-1 text-sm outline-none bg-transparent placeholder:text-gray-300"
        />
        <button onClick={onClose} className="text-cafe-muted hover:text-cafe-secondary text-xs">
          Esc
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto">
        {results.length === 0 && <div className="px-3 py-2 text-xs text-cafe-muted">No matches</div>}
        {results.map((entry, i) => (
          <button
            key={`${i}-${entry}`}
            className={`w-full text-left px-3 py-1.5 text-sm truncate transition-colors ${
              i === selectedIdx
                ? 'bg-cafe-surface-elevated text-cafe'
                : 'text-cafe-secondary hover:bg-cafe-surface-elevated'
            }`}
            onMouseEnter={() => setSelectedIdx(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(entry);
            }}
          >
            {entry}
          </button>
        ))}
      </div>
      <div className="px-3 py-1 text-[10px] text-cafe-muted border-t border-cafe-subtle">
        {'\u2191\u2193 \u9009\u62E9 \u00B7 Enter \u786E\u8BA4 \u00B7 Esc \u5173\u95ED'}
      </div>
    </div>
  );
}
