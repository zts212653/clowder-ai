'use client';

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info';
  args: string[];
  timestamp: number;
}

const LEVEL_STYLES: Record<ConsoleEntry['level'], string> = {
  log: 'text-cafe-secondary dark:text-cafe-muted',
  info: 'text-[var(--color-cafe-accent)]',
  warn: 'text-conn-amber-text',
  error: 'text-conn-red-text',
};

const LEVEL_BG: Record<ConsoleEntry['level'], string> = {
  log: '',
  info: '',
  warn: 'bg-conn-amber-bg/50',
  error: 'bg-conn-red-bg/50',
};

interface ConsolePanelProps {
  entries: ConsoleEntry[];
  onClear: () => void;
}

export function ConsolePanel({ entries, onClear }: ConsolePanelProps) {
  return (
    <div className="flex flex-col border-t border-conn-red-ring bg-cafe-surface/80 text-[11px] font-mono">
      {/* Header bar */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-conn-red-ring bg-[var(--console-card-bg)]">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold text-cafe-secondary/70 uppercase tracking-wider">Console</span>
          {entries.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-conn-amber-bg text-conn-amber-text text-[9px] font-bold">
              {entries.length}
            </span>
          )}
        </div>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-[10px] text-cafe-secondary/50 hover:text-cafe-secondary transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Entries */}
      <div className="overflow-y-auto max-h-[200px]">
        {entries.length === 0 ? (
          <div className="px-3 py-4 text-center text-cafe-secondary/30 text-xs">No console output</div>
        ) : (
          entries.map((entry, i) => (
            <div
              key={`${entry.timestamp}-${i}`}
              className={`flex items-start gap-2 px-2 py-0.5 border-b border-conn-red-ring/30 ${LEVEL_BG[entry.level]}`}
            >
              <span className={`shrink-0 w-10 ${LEVEL_STYLES[entry.level]}`}>{entry.level}</span>
              <span className="text-cafe-secondary/80 break-all">{entry.args.join(' ')}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
