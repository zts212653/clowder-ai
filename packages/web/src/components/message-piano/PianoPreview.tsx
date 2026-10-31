import type { ChatMessage } from '@/stores/chat-types';
import { CatAvatar } from '../CatAvatar';
import { formatTime, messageNavigatorPreviewText } from '../ClassicMessageNavigator';
import type { PianoKey } from './piano-geometry';

export function PianoPreview({
  message,
  keyData,
  trackHeight,
  label,
  ownerName,
  color,
}: {
  message: ChatMessage;
  keyData: PianoKey;
  trackHeight: number;
  label: string;
  ownerName: string;
  color: string;
}) {
  const expandedHeight = Math.max(6, keyData.trackHeight);
  const top = Math.max(
    0,
    Math.min(trackHeight - expandedHeight, keyData.trackTop + keyData.trackHeight / 2 - expandedHeight / 2),
  );
  const human = message.from?.kind === 'user';
  const actorCatId = message.from?.kind === 'agent' ? message.from.catId : undefined;
  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-[7px] z-20 border border-cafe-surface"
        style={{ top, height: expandedHeight, width: 10, backgroundColor: color }}
      />
      <div
        role="tooltip"
        className="pointer-events-none absolute right-full mr-2 w-[200px] -translate-y-1/2 rounded-lg border border-cafe-divider bg-cafe-surface p-2 text-xs shadow-sm text-cafe"
        style={{ top: Math.max(24, Math.min(trackHeight - 24, keyData.trackTop)) }}
      >
        <div className="flex items-center gap-2 font-medium">
          {actorCatId ? (
            <CatAvatar catId={actorCatId} size={20} ring="none" />
          ) : (
            <span
              aria-hidden="true"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: human ? 'var(--color-cocreator-primary)' : 'var(--cafe-text-muted)' }}
            >
              {human ? Array.from(ownerName)[0] : '·'}
            </span>
          )}
          <span>
            {label} · {formatTime(message.timestamp)}
          </span>
        </div>
        <div className="line-clamp-2 mt-1">{messageNavigatorPreviewText(message)}</div>
        {keyData.error && <div className="mt-1 text-conn-red-text">○ 这里出过错</div>}
        {keyData.awaitingResponse && <div className="mt-1">⚑ 等你回应</div>}
      </div>
    </>
  );
}
