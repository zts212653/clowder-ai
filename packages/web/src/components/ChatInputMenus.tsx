'use client';

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { type CatOption, GAME_LIST, WEREWOLF_MODES } from './chat-input-options';

/** SVG icon components for game menu — no emoji (design fidelity rule). */
function WolfIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M10 2L7 5.5 3 6l1.5 4L3 14l4 1 3 3 3-3 4-1-1.5-4L17 6l-4-.5L10 2zm0 3l1.5 2 2.5.3-1 2.7 1 2.5-2.5.7L10 15l-1.5-1.8L6 12.5l1-2.5-1-2.7L8.5 7 10 5z" />
    </svg>
  );
}

function PlayerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
    </svg>
  );
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
      <path
        fillRule="evenodd"
        d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z"
        clipRule="evenodd"
      />
    </svg>
  );
}

const MODE_ICONS: Record<string, (props: { className?: string }) => React.ReactNode> = {
  player: PlayerIcon,
  'god-view': EyeIcon,
  'player-voice': MicIcon,
  'god-view-voice': MicIcon,
};

interface ChatInputMenusProps {
  catOptions: CatOption[];
  showMentions: boolean;
  showGameMenu: boolean;
  gameStep: 'list' | 'modes';
  onGameStepChange: (step: 'list' | 'modes') => void;
  selectedIdx: number;
  onSelectIdx: (i: number) => void;
  onInsertMention: (opt: CatOption) => void;
  onSendCommand: (command: string) => void;
  menuRef: RefObject<HTMLDivElement>;
}

export function ChatInputMenus({
  catOptions,
  showMentions,
  showGameMenu,
  gameStep,
  onGameStepChange,
  selectedIdx,
  onSelectIdx,
  onInsertMention,
  onSendCommand,
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

  const handleGameDrillIn = useCallback(() => {
    onGameStepChange('modes');
    onSelectIdx(0);
  }, [onGameStepChange, onSelectIdx]);

  return (
    <>
      {showMentions && (
        <div
          ref={menuRef}
          className="absolute bottom-full left-4 mb-2 bg-cafe-surface rounded-xl shadow-lg border border-cafe overflow-hidden w-64 z-10 max-h-80 flex flex-col"
        >
          <div ref={scrollRef} className="overflow-y-auto flex-1">
            {catOptions.map((opt, i) => (
              <button
                key={opt.id}
                ref={i === selectedIdx ? selectedRef : undefined}
                className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${i === selectedIdx ? 'bg-cafe-surface-elevated' : 'hover:bg-cafe-surface-elevated'}`}
                onMouseEnter={() => onSelectIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onInsertMention(opt);
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={opt.avatar}
                  alt={opt.label}
                  className="w-7 h-7 rounded-full"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold" style={{ color: opt.color }}>
                    {opt.label}
                  </div>
                  <div className="text-xs text-cafe-muted">{opt.desc}</div>
                </div>
              </button>
            ))}
          </div>
          {canScrollDown && (
            <div className="px-4 py-1 text-[10px] text-cafe-muted text-center border-t border-cafe-subtle bg-gradient-to-t from-white shrink-0">
              ↓ 还有更多猫猫
            </div>
          )}
          {catOptions.length === 0 && <div className="px-4 py-2.5 text-xs text-cafe-muted">无匹配猫猫</div>}
          <div className="px-4 py-1.5 text-xs text-cafe-muted border-t border-cafe-subtle shrink-0">
            {'\u2191\u2193 \u9009\u62E9 \u00B7 Enter \u786E\u8BA4 \u00B7 Esc \u5173\u95ED'}
          </div>
        </div>
      )}

      {showGameMenu && gameStep === 'list' && (
        <div
          ref={menuRef}
          className="absolute bottom-full left-4 mb-2 bg-cafe-surface rounded-xl shadow-lg border border-cafe overflow-hidden w-72 z-10"
        >
          <div className="px-4 py-2 text-xs text-cafe-muted font-medium border-b border-cafe-subtle">选择游戏</div>
          {GAME_LIST.map((game, i) => (
            <button
              key={game.id}
              data-testid={`game-item-${game.id}`}
              className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors ${i === selectedIdx ? 'bg-indigo-50' : 'hover:bg-cafe-surface-elevated'}`}
              onMouseEnter={() => onSelectIdx(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                handleGameDrillIn();
              }}
            >
              <WolfIcon className="w-6 h-6 text-indigo-500" />
              <div>
                <div className="text-sm font-semibold text-cafe-secondary">{game.label}</div>
                <div className="text-xs text-cafe-muted">{game.desc}</div>
              </div>
              <svg className="ml-auto w-4 h-4 text-cafe-muted" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          ))}
          <div className="px-4 py-1.5 text-xs text-cafe-muted border-t border-cafe-subtle">Enter 选择 · Esc 关闭</div>
        </div>
      )}

      {showGameMenu && gameStep === 'modes' && (
        <div
          ref={menuRef}
          className="absolute bottom-full left-4 mb-2 bg-cafe-surface rounded-xl shadow-lg border border-cafe overflow-hidden w-72 z-10"
        >
          <button
            className="w-full text-left px-4 py-2 text-xs text-indigo-500 font-medium border-b border-cafe-subtle hover:bg-indigo-50 transition-colors flex items-center gap-1"
            onMouseDown={(e) => {
              e.preventDefault();
              onGameStepChange('list');
              onSelectIdx(0);
            }}
          >
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            狼人杀 — 选择模式
          </button>
          {WEREWOLF_MODES.map((mode, i) => {
            const IconComponent = MODE_ICONS[mode.id] ?? PlayerIcon;
            return (
              <button
                key={mode.id}
                data-testid={`game-mode-${mode.id}`}
                className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${i === selectedIdx ? 'bg-indigo-50' : 'hover:bg-cafe-surface-elevated'}`}
                onMouseEnter={() => onSelectIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSendCommand(mode.command);
                }}
              >
                <IconComponent className="w-5 h-5 text-indigo-400" />
                <div>
                  <div className="text-sm font-semibold text-cafe-secondary">{mode.label}</div>
                  <div className="text-xs text-cafe-muted">{mode.desc}</div>
                </div>
              </button>
            );
          })}
          <div className="px-4 py-1.5 text-xs text-cafe-muted border-t border-cafe-subtle">
            {'\u2191\u2193 \u9009\u62E9 \u00B7 Enter \u786E\u8BA4 \u00B7 Esc \u5173\u95ED'}
          </div>
        </div>
      )}
    </>
  );
}
