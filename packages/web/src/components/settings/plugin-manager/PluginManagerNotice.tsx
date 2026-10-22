/** Kept at the existing notice position; a saved-with-warning receipt is not an error. */
export function PluginManagerNotice({
  message,
  warning = false,
}: {
  message: string | null | undefined;
  warning?: boolean;
}) {
  if (!message) return null;
  return (
    <div
      role={warning ? 'status' : 'alert'}
      className={`rounded-xl px-3 py-2.5 text-sm ${warning ? 'bg-[var(--console-card-bg)] text-cafe-secondary' : 'bg-conn-red-bg text-conn-red-text'}`}
    >
      {message}
    </div>
  );
}
