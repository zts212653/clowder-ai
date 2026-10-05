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
  /**
   * How the cat's reply is drawn. `bubble` (default) is the framed bubble with an avatar column that every message type
   * has always had. `nameplate` is the Café 1.6 cat reply (DESIGN.md「对话」): no avatar column (the identity sits in the
   * plate the caller puts in `header`), and the body is not framed — no fill, padding, radius, hover lift or clipping.
   * `human` is the Café 1.6 presentation of your own message (DESIGN.md「对话」): right-aligned, no avatar column and no
   * signature (the caller puts nothing about who you are in `header`), one whole block with 12px corners (the corner tail and
   * the caller's radius are not used), the text left-aligned inside it, hugging a short message and stopping at about eighty
   * percent of the reading column with the blank on the left. The frame is real, so overflow is still clipped to it.
   * An explicit opt-in so the shared primitive never changes for the other message types.
   */
  presentation?: 'bubble' | 'nameplate' | 'human';
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
  presentation = 'bubble',
}: MessageBubbleProps) {
  const isRight = align === 'right';

  if (presentation === 'nameplate') {
    // The cat's reply in the new presentation: the reading column's left edge is where it starts and its right edge is
    // where it may end. No avatar column (the plate carries the identity) and no frame around the body. The body div
    // keeps its testid so the message stays findable the way it always was. It is not clipped: artwork cards and
    // receipts inside it have shadows and focus rings that the frame's `overflow-hidden` would cut off.
    return (
      <div
        data-message-id={messageId}
        className={`flex mb-4 items-start ${wrapperClassName}`.trim()}
        style={wrapperStyle}
      >
        <div className={`${maxWidth ?? 'max-w-full'} min-w-0`}>
          {header}
          <div data-testid="message-bubble" className={bubbleClassName.trim()} style={bubbleStyle}>
            {children}
          </div>
          {footer}
        </div>
      </div>
    );
  }

  if (presentation === 'human') {
    return (
      <div
        data-message-id={messageId}
        className={`flex justify-end mb-4 items-start ${wrapperClassName}`.trim()}
        style={wrapperStyle}
      >
        <div className={`${maxWidth ?? 'max-w-[80%]'} min-w-0 flex flex-col items-end`}>
          {header}
          <div
            data-testid="message-bubble"
            className={`rounded-xl px-3.5 py-2 text-left min-w-0 max-w-full overflow-hidden ${bubbleClassName}`.trim()}
            style={bubbleStyle}
          >
            {children}
          </div>
          {footer}
        </div>
      </div>
    );
  }

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
          data-testid="message-bubble"
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
