import { type CSSProperties, memo } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import type { PianoKey } from './piano-geometry';

function inkStyle(key: PianoKey, type: ChatMessage['type'], color: string, gap: number): CSSProperties {
  if (key.error)
    return { top: (key.trackHeight - Math.max(6, key.trackHeight)) / 2, height: Math.max(6, key.trackHeight) };
  if (type === 'system')
    return { top: Math.max(0, key.trackHeight / 2 - 1), height: Math.min(2, key.trackHeight), backgroundColor: color };
  return { top: gap / 2, bottom: gap / 2, backgroundColor: color };
}

export const PianoMessageKey = memo(function PianoMessageKey({
  keyData,
  message,
  id,
  label,
  selected,
  compact,
  sameSender,
  color,
}: {
  keyData: PianoKey;
  message: ChatMessage;
  id: string;
  label: string;
  selected: boolean;
  compact: boolean;
  sameSender: boolean;
  color: string;
}) {
  const gap = keyData.trackHeight >= 3 ? (sameSender ? 1 : 2) : 0;
  return (
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      aria-label={label}
      data-message-piano-key={keyData.id}
      data-message-piano-error={keyData.error || undefined}
      data-message-piano-response={keyData.awaitingResponse || undefined}
      className="absolute right-2 z-10"
      style={{ top: keyData.trackTop, height: keyData.trackHeight, width: compact ? 4 : 6 }}
    >
      <div
        className={keyData.error ? 'absolute inset-x-0 border border-conn-red-text' : 'absolute inset-x-0'}
        style={inkStyle(keyData, message.type, color, gap)}
      />
      {keyData.awaitingResponse && (
        <span aria-hidden="true" className="absolute -left-2 top-0 text-cafe text-xs leading-none">
          ⚑
        </span>
      )}
    </div>
  );
});
