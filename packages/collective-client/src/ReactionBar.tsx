import type { CollectiveReactionEmoji, CollectiveReactionSummary } from './client-types.js';

export function reactionsForEvent(
  eventId: string,
  reactions: readonly CollectiveReactionSummary[],
): readonly CollectiveReactionSummary[] {
  return reactions.filter((reaction) => reaction.eventId === eventId && reaction.humanIds.length > 0);
}

export function ReactionBar({
  eventId,
  reactions,
  currentHumanId,
  humanNames,
  pending,
  error,
  onSetReaction,
}: {
  readonly eventId: string;
  readonly reactions: readonly CollectiveReactionSummary[];
  readonly currentHumanId: string;
  readonly humanNames: Readonly<Record<string, string>>;
  readonly pending?: CollectiveReactionEmoji;
  readonly error?: string;
  readonly onSetReaction: (emoji: CollectiveReactionEmoji, active: boolean) => void;
}) {
  const existing = reactionsForEvent(eventId, reactions);
  const active = new Set(
    existing.filter((reaction) => reaction.humanIds.includes(currentHumanId)).map((item) => item.emoji),
  );
  const names = (reaction: CollectiveReactionSummary) =>
    reaction.humanIds.map((humanId) => humanNames[humanId] ?? `成员 ${humanId.slice(-6)}`).join('、');

  if (existing.length === 0 && pending === undefined && !error) return null;
  return (
    <div className="reaction-bar" aria-busy={pending !== undefined}>
      {existing.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          className="reaction-chip"
          aria-label={`${reaction.emoji} · ${names(reaction)}`}
          aria-pressed={active.has(reaction.emoji)}
          disabled={pending !== undefined}
          onClick={() => onSetReaction(reaction.emoji, !active.has(reaction.emoji))}
        >
          <span className="reaction-chip-visual">
            <span aria-hidden="true">{reaction.emoji}</span>
            <span>{reaction.humanIds.length}</span>
          </span>
        </button>
      ))}
      {pending !== undefined && <output className="reaction-pending">{pending} 回应正在保存…</output>}
      {error && (
        <p className="reaction-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
