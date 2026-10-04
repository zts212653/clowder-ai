export function MemoryReadState({
  loading,
  error,
  empty,
  noun,
  retry,
}: {
  loading: boolean;
  error: boolean;
  empty: boolean;
  noun: string;
  retry: () => void;
}) {
  if (!loading && !error && !empty) return null;
  return (
    <div
      role={error ? 'alert' : 'status'}
      className="rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-4 text-sm text-cafe-muted"
    >
      {loading ? `正在读取${noun}…` : error ? `暂时读不到${noun}` : `还没有${noun}`}
      {error && (
        <button type="button" onClick={retry} className="ml-3 text-cafe-accent underline">
          重试
        </button>
      )}
    </div>
  );
}
