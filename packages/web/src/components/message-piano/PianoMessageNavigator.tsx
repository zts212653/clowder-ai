'use client';

import { useCallback, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { catSlug } from '@/lib/cat-slug';
import {
  formatTime,
  getSenderLabel,
  type MessageNavigatorProps,
  messageNavigatorPreviewText,
} from '../ClassicMessageNavigator';
import { PianoMessageKey } from './PianoMessageKey';
import { PianoPreview } from './PianoPreview';
import { usePianoGeometry } from './usePianoGeometry';
import { usePianoInput } from './usePianoInput';

export function PianoMessageNavigator({
  messages,
  scrollContainerRef,
  onJumpToMessage,
  beginUserScroll,
  compact = false,
  hasMore = false,
  observerKey,
  onTrackReadyChange,
}: MessageNavigatorProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const prefix = useId().replaceAll(':', '');
  const geometry = usePianoGeometry(scrollContainerRef, trackRef, messages, observerKey);
  const input = usePianoInput(trackRef, scrollContainerRef, geometry, beginUserScroll, onJumpToMessage, observerKey);
  const { getCatById } = useCatData();
  const coCreator = useCoCreatorConfig();
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const ready = geometry !== null;
  useLayoutEffect(() => {
    onTrackReadyChange?.(ready);
    return () => onTrackReadyChange?.(false);
  }, [onTrackReadyChange, ready]);
  const activeKey = geometry?.keys[input.selected];
  const activeMessage = activeKey ? byId.get(activeKey.id) : undefined;
  const idFor = (id: string) => `piano-${prefix}-${encodeURIComponent(id)}`;
  const sender = useCallback(
    (message: (typeof messages)[number]) => getSenderLabel(message, (id) => getCatById(id.toLowerCase()), coCreator),
    [getCatById, coCreator],
  );
  const identityColor = useCallback(
    (message: (typeof messages)[number]) => {
      const actorCatId = message.from?.kind === 'agent' ? message.from.catId : undefined;
      return actorCatId
        ? `var(--color-${catSlug(getCatById(actorCatId.toLowerCase())?.id ?? actorCatId)}-primary, var(--console-cat-fallback))`
        : 'var(--cafe-text-muted)';
    },
    [getCatById],
  );
  const keys = geometry?.keys;
  const keyDetails = useMemo(
    () =>
      keys?.flatMap((key, index) => {
        const message = byId.get(key.id);
        if (!message) return [];
        const previous = byId.get(keys[index - 1]?.id);
        const sameSender =
          !!previous?.from && !!message.from && JSON.stringify(previous.from) === JSON.stringify(message.from);
        const status = `${key.error ? '，这里出过错' : ''}${key.awaitingResponse ? '，等你回应' : ''}`;
        return [
          {
            key,
            message,
            sameSender,
            label: `${sender(message)}，${formatTime(message.timestamp)}：${messageNavigatorPreviewText(message) ?? ''}${status}`,
            color: identityColor(message),
          },
        ];
      }),
    [keys, byId, sender, identityColor],
  );

  return (
    <div
      ref={trackRef}
      data-message-navigator
      data-message-piano
      data-message-piano-ready={ready || undefined}
      role="listbox"
      aria-label={`已加载的消息位置，共${geometry?.keys.length ?? 0}条`}
      aria-activedescendant={activeKey ? idFor(activeKey.id) : undefined}
      aria-hidden={!ready || undefined}
      tabIndex={ready ? 0 : -1}
      className={`absolute right-0.5 top-2 bottom-2 z-10 outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent ${compact ? 'w-5' : 'w-6'} ${ready ? 'cursor-pointer' : 'invisible pointer-events-none'}`}
      {...input.handlers}
    >
      {hasMore && ready && (
        <div
          role="img"
          className="absolute top-0 right-1 h-2.5 w-3 border-t border-dashed border-cafe-muted"
          title="更早的消息尚未加载"
          aria-label="更早的消息尚未加载"
        />
      )}
      {keyDetails?.map(({ key, message, sameSender, label, color }) => (
        <PianoMessageKey
          key={key.id}
          keyData={key}
          message={message}
          id={idFor(key.id)}
          label={label}
          selected={activeKey?.id === key.id}
          compact={compact}
          sameSender={sameSender}
          color={color}
        />
      ))}
      {geometry && (
        <>
          <div
            data-message-piano-thumb
            className="absolute right-0.5 z-20 cursor-grab touch-none border border-[var(--cafe-text)] rounded-sm"
            style={{ top: geometry.thumbTop, height: geometry.thumbHeight, width: compact ? 14 : 16 }}
          />
          <div
            data-message-piano-grab
            className="absolute right-0.5 z-0 cursor-grab touch-none"
            style={{ top: geometry.grabTop, height: geometry.grabHeight, width: compact ? 14 : 16 }}
          />
        </>
      )}
      {input.preview && activeKey && activeMessage && geometry && (
        <PianoPreview
          message={activeMessage}
          keyData={activeKey}
          trackHeight={geometry.trackHeight}
          label={sender(activeMessage)}
          ownerName={coCreator.name}
          color={identityColor(activeMessage)}
        />
      )}
    </div>
  );
}
