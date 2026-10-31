import type {
  ModificationLineCopy,
  ModificationProgressActionKind,
  ModificationProgressIndicator,
} from './modification-progress-copy';

const DOT: Record<Exclude<ModificationProgressIndicator, 'spinner'>, string> = {
  neutral: 'bg-current opacity-60',
  attention: 'bg-semantic-warning',
  danger: 'bg-semantic-critical',
  success: 'bg-semantic-success',
};

function Indicator({ indicator }: { indicator: ModificationProgressIndicator }) {
  return indicator === 'spinner' ? (
    <span
      aria-hidden="true"
      data-indicator="spinner"
      className="mt-1 inline-block h-3 w-3 shrink-0 rounded-full border-2 border-current border-t-transparent opacity-60 motion-safe:animate-spin"
    />
  ) : (
    <span
      aria-hidden="true"
      data-indicator={indicator}
      className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${DOT[indicator]}`}
    />
  );
}

/**
 * One line of real request progress, written for the conversation: state dot, plain words, and the one
 * action the state allows. State colour is carried by the dot only; the words stay in the normal text
 * colour. Words, action and the neutral dot take the colour of the surrounding text, because the line also
 * sits inside the user's own tinted message bubble where the neutral palette is too faint. An action is drawn
 * only when the host actually wired it, never as a control that does nothing.
 */
export function ModificationProgressRow({
  copy,
  busy = false,
  notice,
  handlers,
}: {
  copy: ModificationLineCopy;
  busy?: boolean;
  /** A short alert about the last action on this line (a cancel or an open that did not complete). */
  notice?: string | null;
  handlers: Partial<Record<ModificationProgressActionKind, () => void>>;
}) {
  const handler = copy.action ? handlers[copy.action.kind] : undefined;
  return (
    <div
      data-testid="modification-progress"
      data-state={copy.key}
      className="mt-2 flex min-w-0 items-start gap-2 text-xs"
    >
      <Indicator indicator={copy.indicator} />
      <div className="min-w-0 flex-1">
        <output className="block">
          <span className="block break-words">{copy.title}</span>
          {copy.detail ? <span className="block break-words opacity-80">{copy.detail}</span> : null}
        </output>
        {notice ? (
          <p role="alert" className="mt-1 break-words opacity-80">
            {notice}
          </p>
        ) : null}
      </div>
      {copy.action && handler ? (
        <button
          type="button"
          aria-label={copy.action.label}
          disabled={busy}
          onClick={handler}
          className="shrink-0 underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copy.action.compactLabel}
        </button>
      ) : null}
    </div>
  );
}
