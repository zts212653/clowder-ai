'use client';

/**
 * F054: Story Export Page
 *
 * Renders story cards using the same visual style as real ChatMessage bubbles.
 * Designed for screenshots / long-image export for social media (小红薯).
 *
 * Usage: /story-export
 */

import { useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { hexToRgba } from '@/lib/color-utils';
import { CAT_STYLES, STORY_CARDS, type StoryCard as StoryCardType, type StoryMessage } from './story-data';

function StoryBubble({ msg }: { msg: StoryMessage }) {
  const style = CAT_STYLES[msg.speaker];
  const isUser = msg.speaker === 'user';
  const [thinkingExpanded, setThinkingExpanded] = useState(true); // default expanded for export

  const bubbleClasses = isUser
    ? `rounded-2xl rounded-br-sm ${msg.isWhisper ? 'bg-amber-50 text-amber-900 border border-dashed border-amber-300' : 'bg-[#FEF3C7] text-amber-900'}`
    : `${style.bubbleRadius} ${style.font ?? ''} border`;

  const bubbleStyle = isUser
    ? undefined
    : { backgroundColor: style.secondary, borderColor: hexToRgba(style.primary, 0.3) };

  const nameLabel = msg.displayName ?? style.displayName;

  return (
    <div className={`flex gap-2 mb-4 items-start ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div
        className="rounded-full ring-2 overflow-hidden flex-shrink-0 bg-cafe-surface-elevated flex items-center justify-center"
        style={{
          width: 32,
          height: 32,
          ['--tw-ring-color' as string]: style.primary,
        }}
      >
        <img src={style.avatar} alt={nameLabel} width={32} height={32} className="object-cover w-full h-full" />
      </div>

      {/* Bubble */}
      <div className="max-w-[80%] min-w-0">
        {/* Name + badge */}
        <div className={`mb-1 flex items-center gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
          {isUser && msg.badge && <BadgeTag badge={msg.badge} />}
          <span className="text-xs font-semibold" style={{ color: isUser ? undefined : style.primary, opacity: 0.8 }}>
            {nameLabel}
          </span>
          {!isUser && msg.badge && <BadgeTag badge={msg.badge} />}
        </div>

        <div className={`px-4 py-3 ${bubbleClasses}`} style={bubbleStyle}>
          {/* Thinking / inner monologue */}
          {msg.thinking && (
            <div className="mb-1">
              <button
                onClick={() => setThinkingExpanded((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-cafe-secondary hover:text-cafe-secondary transition-colors mb-1"
              >
                <span
                  className="text-[10px]"
                  style={{
                    transform: thinkingExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    display: 'inline-block',
                    transition: 'transform 0.15s',
                  }}
                >
                  &#9654;
                </span>
                <span>&#128173; 心里话</span>
              </button>
              {thinkingExpanded && (
                <div className="border-l-2 border-cafe pl-3 opacity-80">
                  <MarkdownContent content={msg.thinking} className={style.font} />
                </div>
              )}
            </div>
          )}
          {/* Main content */}
          {msg.content && <MarkdownContent content={msg.content} className={style.font} />}
        </div>

        {/* Annotation */}
        {msg.annotation && (
          <div className={`mt-1 text-[11px] text-cafe-muted ${isUser ? 'text-right' : ''}`}>{msg.annotation}</div>
        )}
        {/* Reaction row */}
        {msg.reactions && (
          <div className={`mt-1 flex gap-1 ${isUser ? 'justify-end' : ''}`}>
            {msg.reactions.map((r, ri) => (
              <span key={ri} className="text-xs bg-cafe-surface-elevated rounded-full px-1.5 py-0.5">
                {r}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BadgeTag({ badge }: { badge: NonNullable<StoryMessage['badge']> }) {
  const colorMap = {
    red: 'bg-red-50 text-red-500',
    green: 'bg-green-50 text-green-600',
    amber: 'bg-amber-100 text-amber-600',
    blue: 'bg-blue-50 text-blue-500',
  };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${colorMap[badge.color]}`}>{badge.text}</span>;
}

function StoryCardView({ card, index }: { card: StoryCardType; index: number }) {
  return (
    <div className="mb-8">
      {/* Card divider / header */}
      <div className="mb-6 text-center">
        <div className="text-xs text-cafe-muted mb-1">#{index + 1}</div>
        <h2 className="text-xl font-bold text-cafe">{card.title}</h2>
        {card.subtitle && <p className="text-sm text-cafe-secondary mt-1">{card.subtitle}</p>}
        <div className="mt-3 mx-auto w-16 h-0.5 bg-gray-200 rounded-full" />
      </div>

      {/* Messages */}
      <div className="space-y-0">
        {card.messages.map((msg, i) => (
          <StoryBubble key={i} msg={msg} />
        ))}
      </div>
    </div>
  );
}

export default function StoryExportPage() {
  return (
    <div className="min-h-screen bg-cafe-surface-elevated">
      {/* Header */}
      <div className="bg-cafe-surface border-b border-cafe py-6 text-center">
        <h1 className="text-2xl font-bold text-cafe">猫猫杀名场面集锦</h1>
        <p className="text-sm text-cafe-secondary mt-1">当 AI 猫猫们互相贴标签猜词 · 一个铲屎官的恶趣味编年史</p>
        <p className="text-xs text-cafe-muted mt-2">七届 · 三只猫 · 无数名场面</p>
      </div>

      {/* Cards */}
      <div className="max-w-lg mx-auto px-4 py-8">
        {STORY_CARDS.map((card, i) => (
          <StoryCardView key={i} card={card} index={i} />
        ))}

        {/* Footer */}
        <div className="text-center py-8 border-t border-cafe mt-4">
          <p className="text-sm text-cafe-secondary">Clowder AI</p>
          <p className="text-xs text-cafe-muted mt-1">三只 AI 猫猫 + 一个恶趣味铲屎官</p>
        </div>
      </div>
    </div>
  );
}
