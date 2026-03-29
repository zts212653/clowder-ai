'use client';

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info';
  args: string[];
  timestamp: number;
}

const LEVEL_STYLES: Record<ConsoleEntry['level'], string> = {
  log: 'text-cafe-secondary dark:text-gray-400',
  info: 'text-blue-600 dark:text-blue-400',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
};

const LEVEL_BG: Record<ConsoleEntry['level'], string> = {
  log: '',
  info: '',
  warn: 'bg-amber-50/50 dark:bg-amber-900/10',
  error: 'bg-red-50/50 dark:bg-red-900/10',
};

interface ConsolePanelProps {
  entries: ConsoleEntry[];
  onClear: () => void;
}

export function ConsolePanel({ entries, onClear }: ConsolePanelProps) {
  return (
    <div className="flex flex-col border-t border-[#FFDDD2] bg-cafe-surface/80 text-[11px] font-mono">
      {/* Header bar */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-[#FFDDD2] bg-[#FDF8F3]">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold text-[#5a4a42]/70 uppercase tracking-wider">Console</span>
          {entries.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-[#E29578]/20 text-[#E29578] text-[9px] font-bold">
              {entries.length}
            </span>
          )}
        </div>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-[10px] text-[#5a4a42]/50 hover:text-[#5a4a42] transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Entries */}
      <div className="overflow-y-auto max-h-[200px]">
        {entries.length === 0 ? (
          <div className="px-3 py-4 text-center text-[#5a4a42]/30 text-xs">No console output</div>
        ) : (
          entries.map((entry, i) => (
            <div
              key={`${entry.timestamp}-${i}`}
              className={`flex items-start gap-2 px-2 py-0.5 border-b border-[#FFDDD2]/30 ${LEVEL_BG[entry.level]}`}
            >
              <span className={`shrink-0 w-10 ${LEVEL_STYLES[entry.level]}`}>{entry.level}</span>
              <span className="text-[#5a4a42]/80 break-all">{entry.args.join(' ')}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
