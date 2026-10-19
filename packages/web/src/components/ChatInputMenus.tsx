'use client';

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { type CatOption } from './chat-input-options';

interface ChatInputMenusProps {
  catOptions: CatOption[];
  showMentions: boolean;
  selectedIdx: number;
  onSelectIdx: (i: number) => void;
  onInsertMention: (opt: CatOption) => void;
  menuRef: RefObject<HTMLDivElement>;
}

export function ChatInputMenus({
  catOptions,
  showMentions,
  selectedIdx,
  onSelectIdx,
  onInsertMention,
  menuRef,
}: ChatInputMenusProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollDown, setCanScrollDown] = useState(false);

  // Auto-scroll selected item into view on keyboard navigation
  const selectedRef = useCallback((node: HTMLButtonElement | null) => {
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' });
    }
  }, []);

  // Detect if more items are hidden below
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      setCanScrollDown(false);
      return;
    }
    const check = () => setCanScrollDown(el.scrollHeight > el.clientHeight + el.scrollTop + 4);
    check();
    el.addEventListener('scroll', check);
    return () => el.removeEventListener('scroll', check);
  }, []);

  return (
    <>
      {showMentions && (
        <div
          ref={menuRef}
          className="absolute bottom-full left-4 mb-2 bg-cafe-surface-canvas rounded-xl shadow-lg border border-cafe overflow-hidden w-64 z-10 max-h-80 flex flex-col"
        >
          <div ref={scrollRef} className="overflow-y-auto flex-1">
            {catOptions.map((opt, i) => (
              <button
                key={opt.id}
                ref={i === selectedIdx ? selectedRef : undefined}
                className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${i === selectedIdx ? 'bg-cafe-surface-sunken' : 'hover:bg-cafe-surface-elevated'}`}
                onMouseEnter={() => onSelectIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onInsertMention(opt);
                }}
              >
                {opt.isGroup ? (
                  <div className="w-7 h-7 rounded-full bg-cafe-surface flex items-center justify-center shrink-0">
                    <svg className="w-4 h-4 text-cafe-muted" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <path d="M7 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.5 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.615 16.428a1.224 1.224 0 0 1-.569-1.175 6.002 6.002 0 0 1 11.908 0c.058.467-.172.92-.57 1.174A9.953 9.953 0 0 1 7 18a9.953 9.953 0 0 1-5.385-1.572ZM14.5 16h-.106c.07-.297.088-.611.048-.933a7.47 7.47 0 0 0-1.588-3.755 4.502 4.502 0 0 1 5.874 2.636.818.818 0 0 1-.36.98A7.465 7.465 0 0 1 14.5 16Z" />
                    </svg>
                  </div>
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={opt.avatar}
                    alt={opt.label}
                    className="w-7 h-7 rounded-full"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-sm font-semibold truncate" style={{ color: opt.color }}>
                      {opt.label}
                    </span>
                    {opt.isCloud && opt.providerLabel && (
                      <span className="shrink-0 text-micro leading-tight px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400">
                        {'☁️ '}
                        {opt.providerLabel}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-cafe-muted">{opt.desc}</div>
                </div>
              </button>
            ))}
          </div>
          {canScrollDown && (
            <div className="px-4 py-1 text-micro text-cafe-muted text-center border-t border-cafe-subtle bg-gradient-to-t from-[var(--cafe-surface-elevated)] shrink-0">
              ↓ 还有更多猫猫
            </div>
          )}
          {catOptions.length === 0 && <div className="px-4 py-2.5 text-xs text-cafe-muted">无匹配猫猫</div>}
          <div className="px-4 py-1.5 text-xs text-cafe-muted border-t border-cafe-subtle shrink-0">
            {'\u2191\u2193 \u9009\u62E9 \u00B7 Enter \u786E\u8BA4 \u00B7 Esc \u5173\u95ED'}
          </div>
        </div>
      )}
    </>
  );
}
