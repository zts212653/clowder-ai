'use client';

import { useMemo, useState } from 'react';

/* ── Diff parser ─────────────────────────────────────── */

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header';
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface FileDiff {
  path: string;
  hunks: DiffHunk[];
}

function parseUnifiedDiff(diff: string): FileDiff[] {
  if (!diff.trim()) return [];

  const files: FileDiff[] = [];
  const lines = diff.split('\n');
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // Primary path source: diff --git a/... b/...
    const gitHeaderMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitHeaderMatch) {
      current = { path: gitHeaderMatch[2], hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }

    if (line.startsWith('+++ b/') && current) {
      // Override with +++ path (handles renames: diff --git has old, +++ has new)
      current.path = line.slice(6);
      continue;
    }
    // Skip --- and +++ lines (including +++ /dev/null for deleted files)
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) continue;

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (hunkMatch && current) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      hunk = { header: line, lines: [] };
      current.hunks.push(hunk);
      hunk.lines.push({ type: 'header', content: hunkMatch[3] || '', oldLine: null, newLine: null });
      continue;
    }

    if (!hunk) continue;

    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', content: line.slice(1), oldLine: null, newLine: newLine++ });
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'remove', content: line.slice(1), oldLine: oldLine++, newLine: null });
    } else if (line.startsWith(' ') || line === '') {
      hunk.lines.push({ type: 'context', content: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }

  return files;
}

/* ── Side-by-side pairing ────────────────────────────── */

interface SidePair {
  left: DiffLine | null;
  right: DiffLine | null;
}

function pairLines(lines: DiffLine[]): SidePair[] {
  const pairs: SidePair[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.type === 'header') {
      pairs.push({ left: line, right: line });
      i++;
      continue;
    }
    if (line.type === 'context') {
      pairs.push({ left: line, right: line });
      i++;
      continue;
    }

    // Collect consecutive removes then adds to pair them
    const removes: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'remove') removes.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);

    const max = Math.max(removes.length, adds.length);
    for (let j = 0; j < max; j++) {
      pairs.push({ left: removes[j] ?? null, right: adds[j] ?? null });
    }
  }
  return pairs;
}

/* ── Line coloring ───────────────────────────────────── */

const lineStyles: Record<DiffLine['type'], string> = {
  add: 'bg-green-900/30 text-green-300',
  remove: 'bg-red-900/30 text-red-300',
  context: 'text-cafe-muted',
  header: 'bg-blue-900/20 text-blue-400 italic',
};

const gutterStyles: Record<DiffLine['type'], string> = {
  add: 'bg-green-900/40 text-green-500',
  remove: 'bg-red-900/40 text-red-500',
  context: 'text-cafe-secondary',
  header: 'bg-blue-900/20 text-blue-500',
};

const prefixMap: Record<DiffLine['type'], string> = {
  add: '+',
  remove: '-',
  context: ' ',
  header: '',
};

/* ── Components ──────────────────────────────────────── */

function UnifiedView({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <table className="w-full text-[11px] font-mono border-collapse">
      <tbody>
        {hunks.map((hunk, hi) =>
          hunk.lines.map((line, li) => (
            <tr key={`${hi}-${li}`} className={lineStyles[line.type]}>
              <td
                className={`w-10 text-right px-1.5 select-none border-r border-gray-700/50 ${gutterStyles[line.type]}`}
              >
                {line.oldLine ?? ''}
              </td>
              <td
                className={`w-10 text-right px-1.5 select-none border-r border-gray-700/50 ${gutterStyles[line.type]}`}
              >
                {line.newLine ?? ''}
              </td>
              <td className="px-2 whitespace-pre overflow-x-auto">
                <span className="select-none text-cafe-secondary mr-1">{prefixMap[line.type]}</span>
                {line.content}
              </td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  );
}

function SideBySideView({ hunks }: { hunks: DiffHunk[] }) {
  const pairs = useMemo(() => hunks.flatMap((h) => pairLines(h.lines)), [hunks]);

  return (
    <table className="w-full text-[11px] font-mono border-collapse">
      <tbody>
        {pairs.map((pair, i) => (
          <tr key={i}>
            {/* Left (old) */}
            <td
              className={`w-8 text-right px-1 select-none border-r border-gray-700/50 ${pair.left ? gutterStyles[pair.left.type] : 'bg-gray-900/50'}`}
            >
              {pair.left?.oldLine ?? ''}
            </td>
            <td
              className={`w-1/2 px-2 whitespace-pre overflow-x-auto ${pair.left ? lineStyles[pair.left.type] : 'bg-gray-900/50'}`}
            >
              {pair.left?.content ?? ''}
            </td>
            {/* Right (new) */}
            <td
              className={`w-8 text-right px-1 select-none border-l border-r border-gray-700/50 ${pair.right ? gutterStyles[pair.right.type] : 'bg-gray-900/50'}`}
            >
              {pair.right?.newLine ?? ''}
            </td>
            <td
              className={`w-1/2 px-2 whitespace-pre overflow-x-auto ${pair.right ? lineStyles[pair.right.type] : 'bg-gray-900/50'}`}
            >
              {pair.right?.content ?? ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── Exported DiffViewer ─────────────────────────────── */

interface DiffViewerProps {
  /** Raw unified diff text */
  diff: string;
  /** Optional: show only a specific file's diff */
  filePath?: string;
  /** Compact mode for rich blocks (no file header, no mode toggle) */
  compact?: boolean;
}

export function DiffViewer({ diff, filePath, compact }: DiffViewerProps) {
  const [mode, setMode] = useState<'unified' | 'split'>('unified');
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);

  const filtered = filePath ? files.filter((f) => f.path === filePath) : files;

  if (filtered.length === 0) {
    return (
      <div className="p-4 text-center text-cafe-secondary text-xs">
        {diff.trim() ? 'No parseable diff hunks found' : 'No changes'}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {!compact && (
        <div className="flex items-center gap-1 px-2 py-1">
          <button
            type="button"
            onClick={() => setMode('unified')}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              mode === 'unified'
                ? 'bg-cocreator-primary/80 text-white'
                : 'text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10'
            }`}
          >
            Unified
          </button>
          <button
            type="button"
            onClick={() => setMode('split')}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              mode === 'split'
                ? 'bg-cocreator-primary/80 text-white'
                : 'text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10'
            }`}
          >
            Side-by-side
          </button>
          <span className="ml-auto text-[10px] text-cafe-secondary">
            {filtered.length} file{filtered.length !== 1 ? 's' : ''} changed
          </span>
        </div>
      )}
      {filtered.map((file) => (
        <div key={file.path} className="rounded border border-gray-700/50 overflow-hidden">
          {!compact && (
            <div className="bg-[#1E1E24] px-3 py-1.5 text-[11px] font-mono text-cafe-muted border-b border-gray-700/50 truncate">
              {file.path}
            </div>
          )}
          <div className="overflow-x-auto bg-[#16161c]">
            {mode === 'unified' ? <UnifiedView hunks={file.hunks} /> : <SideBySideView hunks={file.hunks} />}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Export parser for testing */
export { parseUnifiedDiff };
export type { FileDiff, DiffHunk, DiffLine };
