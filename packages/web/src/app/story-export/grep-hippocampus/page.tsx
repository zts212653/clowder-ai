'use client';

/**
 * Story Export: "我的 AI 猫猫试图教我用生物学的知识 grep 我的脑子"
 *
 * Reuses StoryBubble / StoryCard from the parent story-export page layout.
 * Designed for 小红书 long-image screenshot export.
 *
 * Usage: /story-export/grep-hippocampus
 */

import { useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { hexToRgba } from '@/lib/color-utils';
import type { StoryCard as StoryCardType } from '../story-data';
import { CAT_STYLES, type StoryMessage } from '../story-data';
import { GREP_STORY_CARDS } from './story-data';

function StoryBubble({ msg }: { msg: StoryMessage }) {
  const style = CAT_STYLES[msg.speaker];
  const isUser = msg.speaker === 'user';
  const [thinkingExpanded, setThinkingExpanded] = useState(true);

  const bubbleClasses = isUser
    ? `rounded-2xl rounded-br-sm ${msg.isWhisper ? 'bg-conn-amber-bg text-conn-amber-text border border-dashed border-conn-amber-ring' : 'bg-[var(--semantic-warning-surface)] text-conn-amber-text'}`
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
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
          {/* Thinking */}
          {msg.thinking && (
            <div className="mb-1">
              <button
                onClick={() => setThinkingExpanded((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-cafe-secondary hover:text-cafe-secondary transition-colors mb-1"
              >
                <span
                  className="text-micro"
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
          {msg.content && <MarkdownContent content={msg.content} className={style.font} />}
        </div>

        {msg.annotation && (
          <div className={`mt-1 text-xs text-cafe-muted ${isUser ? 'text-right' : ''}`}>{msg.annotation}</div>
        )}
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
    red: 'bg-conn-red-bg text-conn-red-text',
    green: 'bg-conn-green-bg text-conn-green-text',
    amber: 'bg-[var(--semantic-warning-surface)] text-conn-amber-text',
    blue: 'bg-conn-blue-bg text-conn-blue-text',
  };
  return <span className={`text-micro px-1.5 py-0.5 rounded font-medium ${colorMap[badge.color]}`}>{badge.text}</span>;
}

function StoryCardView({ card, index }: { card: StoryCardType; index: number }) {
  return (
    <div className="mb-8">
      <div className="mb-6 text-center">
        <div className="text-xs text-cafe-muted mb-1">#{index + 1}</div>
        <h2 className="text-xl font-bold text-cafe">{card.title}</h2>
        {card.subtitle && <p className="text-sm text-cafe-secondary mt-1">{card.subtitle}</p>}
        <div className="mt-3 mx-auto w-16 h-0.5 bg-cafe-surface rounded-full" />
      </div>
      <div className="space-y-0">
        {card.messages.map((msg, i) => (
          <StoryBubble key={i} msg={msg} />
        ))}
      </div>
    </div>
  );
}

export default function GrepHippocampusStoryPage() {
  return (
    <div className="min-h-screen bg-cafe-surface-elevated">
      {/* Header */}
      <div className="bg-cafe-surface border-b border-cafe py-6 text-center">
        <h1 className="text-2xl font-bold text-cafe">我的 AI 猫猫试图教我用生物学的知识 grep 我的脑子</h1>
        <p className="text-sm text-cafe-secondary mt-1">他先查了论文，然后一本正经地给我的海马体接了个搜索端点</p>
        <p className="text-xs text-cafe-muted mt-2">砚砚喵 · GPT-5.5 · 2026.06</p>
      </div>

      {/* Cards */}
      <div className="max-w-lg mx-auto px-4 py-8">
        {GREP_STORY_CARDS.map((card, i) => (
          <StoryCardView key={i} card={card} index={i} />
        ))}

        {/* Footer */}
        <div className="text-center py-8 border-t border-cafe mt-4">
          <p className="text-sm text-cafe-secondary italic">&ldquo;他说的每一句都是对的。这才是最好笑的地方。&rdquo;</p>
          <p className="text-xs text-cafe-muted mt-2">Clowder AI · 一只严肃的大缅因猫和他的co-creator</p>
        </div>
      </div>
    </div>
  );
}
