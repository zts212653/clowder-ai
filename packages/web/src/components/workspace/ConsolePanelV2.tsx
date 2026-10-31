'use client';

import { useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import type { ConsoleEntry } from './ConsolePanel';
import { codeToolsCopy } from './code-tools.shell-copy';

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

type LevelFilter = 'all' | 'warn' | 'error';

function matchesFilter(entry: ConsoleEntry, filter: LevelFilter): boolean {
  if (filter === 'warn') return entry.level === 'warn';
  if (filter === 'error') return entry.level === 'error';
  return true;
}

interface ConsolePanelV2Props {
  entries: ConsoleEntry[];
  onClear: () => void;
}

export function ConsolePanelV2({ entries, onClear }: ConsolePanelV2Props) {
  const [filter, setFilter] = useState<LevelFilter>('all');
  const copy = useShellCopy(codeToolsCopy).console;
  const LEVEL_LABELS: Record<ConsoleEntry['level'], string> = {
    log: copy.levelLog,
    info: copy.levelInfo,
    warn: copy.levelWarn,
    error: copy.levelError,
  };
  const visible = entries.filter((entry) => matchesFilter(entry, filter));
  const counts: Record<LevelFilter, number> = {
    all: entries.length,
    warn: entries.filter((entry) => entry.level === 'warn').length,
    error: entries.filter((entry) => entry.level === 'error').length,
  };
  const chips: Array<{ id: LevelFilter; label: string }> = [
    { id: 'all', label: copy.filterAll },
    { id: 'warn', label: copy.filterWarnings },
    { id: 'error', label: copy.filterErrors },
  ];

  return (
    <div className="flex flex-col console-divider-t bg-cafe-surface/80 text-xs font-mono">
      <div className="flex items-center gap-1.5 px-2 py-1 console-divider-b bg-[var(--ws-surface)]">
        <span className="text-micro font-semibold text-[var(--ws-text)]/70">{copy.title}</span>
        <div className="flex items-center gap-1">
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => setFilter(chip.id)}
              className={`px-1.5 py-0.5 rounded text-micro transition-colors ${
                filter === chip.id
                  ? 'bg-[var(--ws-accent)]/20 text-[var(--ws-accent)] font-semibold'
                  : 'text-[var(--ws-text)]/50 hover:text-[var(--ws-text)]'
              }`}
            >
              {chip.label}
              {counts[chip.id] > 0 ? ` ${counts[chip.id]}` : ''}
            </button>
          ))}
        </div>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto text-micro text-[var(--ws-text)]/50 hover:text-[var(--ws-text)] transition-colors"
          >
            {copy.clear}
          </button>
        )}
      </div>

      <div className="overflow-y-auto max-h-[200px]">
        {visible.length === 0 ? (
          <div className="px-3 py-4 text-center text-[var(--ws-text)]/30 text-xs">
            {entries.length === 0 ? copy.empty : copy.emptyFiltered}
          </div>
        ) : (
          visible.map((entry, i) => (
            <div
              key={`${entry.timestamp}-${i}`}
              className={`flex items-start gap-2 px-2 py-0.5 console-divider-b ${LEVEL_BG[entry.level]}`}
            >
              <span className={`shrink-0 w-10 ${LEVEL_STYLES[entry.level]}`}>{LEVEL_LABELS[entry.level]}</span>
              <span className="text-[var(--ws-text)]/80 break-all">{entry.args.join(' ')}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
