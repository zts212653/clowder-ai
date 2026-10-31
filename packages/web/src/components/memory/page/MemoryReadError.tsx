export function MemoryReadError({ noun, retry }: { noun: string; retry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--console-card-bg)] p-4 text-sm text-cafe-secondary"
    >
      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-semantic-critical" />
      <span>暂时读不到{noun}</span>
      <span aria-hidden="true">·</span>
      <button type="button" onClick={retry} className="text-cafe-accent underline">
        重试
      </button>
    </div>
  );
}
