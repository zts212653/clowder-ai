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

function parseUnifiedDiff(diff: string, fallbackFilePath = 'Diff'): FileDiff[] {
  if (!diff.trim()) return [];

  const files: FileDiff[] = [];
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldPath: string | null = null;

  for (const line of lines) {
    // Primary path source: diff --git a/... b/...
    const gitHeaderMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitHeaderMatch) {
      current = { path: gitHeaderMatch[2], hunks: [] };
      files.push(current);
      hunk = null;
      oldPath = null;
      continue;
    }

    if (line.startsWith('--- a/') && current && !hunk) {
      oldPath = line.slice(6);
      continue;
    }
    if (line === '+++ /dev/null' && current && !hunk && oldPath !== null) {
      // Deletion's old-file header is unambiguous even when a path contains " b/".
      current.path = oldPath;
      continue;
    }
    if (line.startsWith('+++ b/') && current && !hunk) {
      // Override with +++ path (handles renames: diff --git has old, +++ has new)
      current.path = line.slice(6);
      continue;
    }
    // Skip --- and +++ lines (including +++ /dev/null for deleted files)
    if (!hunk && (line.startsWith('--- ') || line.startsWith('+++ '))) continue;
    if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) continue;

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (hunkMatch) {
      if (!current) {
        current = { path: fallbackFilePath, hunks: [] };
        files.push(current);
      }
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
  header: 'bg-[var(--semantic-info-surface)] text-[var(--semantic-info)] italic',
};

const gutterStyles: Record<DiffLine['type'], string> = {
  add: 'bg-green-900/40 text-conn-emerald-text',
  remove: 'bg-red-900/40 text-conn-red-text',
  context: 'text-cafe-secondary',
  header: 'bg-[var(--semantic-info-surface)] text-conn-blue-text',
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
    <table className="w-full text-xs font-mono border-collapse">
      <tbody>
        {hunks.map((hunk, hi) =>
          hunk.lines.map((line, li) => (
            <tr key={`${hi}-${li}`} data-diff-line={line.type} className={lineStyles[line.type]}>
              <td className={`w-10 text-right px-1.5 select-none console-divider-r ${gutterStyles[line.type]}`}>
                {line.oldLine ?? ''}
              </td>
              <td className={`w-10 text-right px-1.5 select-none console-divider-r ${gutterStyles[line.type]}`}>
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
    <table className="w-full text-xs font-mono border-collapse">
      <tbody>
        {pairs.map((pair, i) => (
          <tr key={i}>
            {/* Left (old) */}
            <td
              className={`w-8 text-right px-1 select-none console-divider-r ${pair.left ? gutterStyles[pair.left.type] : 'bg-cafe-surface-sunken/50'}`}
            >
              {pair.left?.oldLine ?? ''}
            </td>
            <td
              className={`w-1/2 px-2 whitespace-pre overflow-x-auto ${pair.left ? lineStyles[pair.left.type] : 'bg-cafe-surface-sunken/50'}`}
            >
              {pair.left?.content ?? ''}
            </td>
            {/* Right (new) */}
            <td
              className={`w-8 text-right px-1 select-none console-divider-l console-divider-r ${pair.right ? gutterStyles[pair.right.type] : 'bg-cafe-surface-sunken/50'}`}
            >
              {pair.right?.newLine ?? ''}
            </td>
            <td
              className={`w-1/2 px-2 whitespace-pre overflow-x-auto ${pair.right ? lineStyles[pair.right.type] : 'bg-cafe-surface-sunken/50'}`}
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

export interface DiffViewerLabels {
  unified?: string;
  sideBySide?: string;
  filesChanged?: (count: number) => string;
}

interface DiffViewerProps {
  fallbackFilePath?: string;
  /** Raw unified diff text */
  diff: string;
  /** Optional: show only a specific file's diff */
  filePath?: string;
  /** Compact mode for rich blocks (no file header, no mode toggle) */
  compact?: boolean;
  /** F322 v2: localized labels for the mode toggle and count summary. */
  labels?: DiffViewerLabels;
  /** F322 × C seam (coord-e6d806a7): per-file "open" action. Hidden unless provided. */
  onOpenFile?: (path: string) => void;
  /** Localized label for the open-file action. */
  openFileLabel?: string;
}

export function DiffViewer({
  diff,
  filePath,
  fallbackFilePath,
  compact,
  labels,
  onOpenFile,
  openFileLabel,
}: DiffViewerProps) {
  const [mode, setMode] = useState<'unified' | 'split'>('unified');
  const files = useMemo(() => parseUnifiedDiff(diff, fallbackFilePath), [diff, fallbackFilePath]);

  const filtered = filePath ? files.filter((f) => f.path === filePath) : files;

  if (filtered.length === 0) {
    return (
      <div className="p-4 text-center text-cafe-secondary text-xs">
        {diff.trim() ? 'No parseable diff hunks found' : 'No changes'}
      </div>
    );
  }

  return (
    <div className="cafe-diff-viewer flex flex-col gap-2">
      {!compact && (
        <div className="flex items-center gap-1 px-2 py-1">
          <button
            type="button"
            onClick={() => setMode('unified')}
            className={`px-2 py-0.5 rounded text-micro font-medium transition-colors ${
              mode === 'unified'
                ? 'bg-cafe-accent/80 text-[var(--cafe-surface)]'
                : 'text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10'
            }`}
          >
            {labels?.unified ?? 'Unified'}
          </button>
          <button
            type="button"
            onClick={() => setMode('split')}
            className={`px-2 py-0.5 rounded text-micro font-medium transition-colors ${
              mode === 'split'
                ? 'bg-cafe-accent/80 text-[var(--cafe-surface)]'
                : 'text-cafe-secondary hover:text-cafe-muted hover:bg-cafe-surface/10'
            }`}
          >
            {labels?.sideBySide ?? 'Side-by-side'}
          </button>
          <span className="ml-auto text-micro text-cafe-secondary">
            {labels?.filesChanged
              ? labels.filesChanged(filtered.length)
              : `${filtered.length} file${filtered.length !== 1 ? 's' : ''} changed`}
          </span>
        </div>
      )}
      {filtered.map((file) => (
        <div key={file.path} className="rounded border border-[var(--console-border-soft)] overflow-hidden">
          {!compact &&
            (onOpenFile ? (
              <div className="bg-[var(--ws-editor-bg)] px-3 py-1.5 text-xs font-mono text-cafe-muted console-divider-b flex items-center gap-2">
                <span className="truncate">{file.path}</span>
                <button
                  type="button"
                  onClick={() => onOpenFile(file.path)}
                  className="ml-auto shrink-0 font-sans text-micro text-cafe-interactive/60 hover:text-cafe-interactive transition-colors"
                >
                  {openFileLabel ?? 'Open file'}
                </button>
              </div>
            ) : (
              <div className="bg-[var(--ws-editor-bg)] px-3 py-1.5 text-xs font-mono text-cafe-muted console-divider-b truncate">
                {file.path}
              </div>
            ))}
          <div className="overflow-x-auto bg-[var(--ws-editor-deep)]">
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
