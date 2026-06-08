'use client';

import type { CSSProperties, ReactNode } from 'react';

/**
 * Shared message bubble layout primitive.
 *
 * Single source of truth for the avatar + header + rounded bubble + footer
 * pattern used by all message types (cat, connector, co-creator). Type-specific
 * content and styling are injected via props — the component owns only the
 * structural layout and shared visual properties (padding, hover, overflow).
 *
 * Future theme / OKLCH / spacing changes to the bubble pattern only need to
 * touch this component.
 */

interface MessageBubbleProps {
  /** Message ID for DOM targeting (scrollTo, reply anchors, navigation). */
  messageId: string;
  /** Avatar element — CatAvatar / connector icon / co-creator avatar. */
  avatar: ReactNode;
  /** Header row(s) — name, timestamp, badges, pills.
   *  Consumer controls internal layout (single-row flex or multi-row flex-col). */
  header?: ReactNode;
  /** Main bubble content (markdown, content blocks, rich blocks, etc.). */
  children: ReactNode;
  /** Content below the bubble body (MetadataBadge, etc.). */
  footer?: ReactNode;
  /** left = cat/connector (default), right = co-creator. */
  align?: 'left' | 'right';
  /** Bubble corner radius class (default: 'rounded-2xl').
   *  Cat bubbles use breed-specific variants like 'rounded-2xl rounded-bl-sm'. */
  bubbleRadius?: string;
  /** Extra CSS classes on bubble body div (breed font, whisper border, etc.). */
  bubbleClassName?: string;
  /** Inline styles on bubble body (backgroundColor, color from OKLCH tokens). */
  bubbleStyle?: CSSProperties;
  /** Extra CSS classes on the outer wrapper (cat-persona-derived, group, etc.). */
  wrapperClassName?: string;
  /** Inline styles on outer wrapper (--msg-hue, --msg-chroma CSS vars). */
  wrapperStyle?: CSSProperties;
  /** Override max-width class for content area.
   *  Default: 'max-w-[85%] md:max-w-[75%]' (left) / 'max-w-[75%]' (right). */
  maxWidth?: string;
}

export function MessageBubble({
  messageId,
  avatar,
  header,
  children,
  footer,
  align = 'left',
  bubbleRadius = 'rounded-2xl',
  bubbleClassName = '',
  bubbleStyle,
  wrapperClassName = '',
  wrapperStyle,
  maxWidth,
}: MessageBubbleProps) {
  const isRight = align === 'right';
  const resolvedMaxWidth = maxWidth ?? (isRight ? 'max-w-[75%]' : 'max-w-[85%] md:max-w-[75%]');

  return (
    <div
      data-message-id={messageId}
      className={`flex gap-2 mb-4 items-start ${isRight ? 'justify-end' : ''} ${wrapperClassName}`.trim()}
      style={wrapperStyle}
    >
      {!isRight && avatar}
      <div className={`${resolvedMaxWidth} min-w-0`}>
        {header}
        <div
          className={`px-4 py-3 transition-transform hover:-translate-y-0.5 overflow-hidden ${bubbleRadius} ${bubbleClassName}`.trim()}
          style={bubbleStyle}
        >
          {children}
        </div>
        {footer}
      </div>
      {isRight && avatar}
    </div>
  );
}
