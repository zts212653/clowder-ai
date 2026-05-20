'use client';

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info';
  args: string[];
  timestamp: number;
}

const LEVEL_STYLES: Record<ConsoleEntry['level'], string> = {
  log: 'text-cafe-secondary',
  info: 'text-blue-600 dark:text-blue-400',
  warn: 'text-conn-amber-text dark:text-amber-400',
  error: 'text-conn-red-text dark:text-conn-red-text',
};

const LEVEL_BG: Record<ConsoleEntry['level'], string> = {
  log: '',
  info: '',
  warn: 'bg-conn-amber-bg/50 dark:bg-amber-900/10',
  error: 'bg-conn-red-bg/50 dark:bg-red-900/10',
};

interface ConsolePanelProps {
  entries: ConsoleEntry[];
  onClear: () => void;
}

export function ConsolePanel({ entries, onClear }: ConsolePanelProps) {
  return (
    <div className="flex flex-col border-t border-[var(--console-border-soft)] bg-cafe-surface/80 text-xs font-mono">
      {/* Header bar */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--console-border-soft)] bg-[var(--ws-surface)]">
        <div className="flex items-center gap-1.5">
          <span className="text-micro font-semibold text-[var(--ws-text)]/70 uppercase tracking-wider">Console</span>
          {entries.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-[var(--ws-accent)]/20 text-[var(--ws-accent)] text-micro font-bold">
              {entries.length}
            </span>
          )}
        </div>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-micro text-[var(--ws-text)]/50 hover:text-[var(--ws-text)] transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Entries */}
      <div className="overflow-y-auto max-h-[200px]">
        {entries.length === 0 ? (
          <div className="px-3 py-4 text-center text-[var(--ws-text)]/30 text-xs">No console output</div>
        ) : (
          entries.map((entry, i) => (
            <div
              key={`${entry.timestamp}-${i}`}
              className={`flex items-start gap-2 px-2 py-0.5 border-b border-[var(--console-border-soft)]/30 ${LEVEL_BG[entry.level]}`}
            >
              <span className={`shrink-0 w-10 ${LEVEL_STYLES[entry.level]}`}>{entry.level}</span>
              <span className="text-[var(--ws-text)]/80 break-all">{entry.args.join(' ')}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
