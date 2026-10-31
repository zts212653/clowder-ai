'use client';

export function ReplyRecallButton({ leading, label, onOpen }: { leading: boolean; label: string; onOpen: () => void }) {
  return (
    <>
      {leading ? (
        <span aria-hidden="true" className="flex-none" style={{ color: 'var(--shell-muted)', opacity: 0.6 }}>
          ·
        </span>
      ) : null}
      <button
        type="button"
        data-testid="reply-recall"
        onClick={onOpen}
        className="inline-flex flex-none items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent hover:underline"
        style={{ color: 'var(--shell-muted)' }}
      >
        {label}
      </button>
    </>
  );
}
