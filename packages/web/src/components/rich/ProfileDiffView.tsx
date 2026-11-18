import {
  computeProfileLineDiff,
  type InlineDiffSegment,
  type ProfileDiffHunk,
  type ProfileDiffLine,
} from '@cat-cafe/shared';
import { useMemo } from 'react';
import { originalApprovalCopy } from '../shell/mailbox/original-approval.shell-copy';
import { useShellCopy } from '../shell/shell-copy';

function omittedCountBetween(prev: ProfileDiffHunk, next: ProfileDiffHunk): number {
  if (prev.oldCount > 0 && next.oldCount > 0) {
    return Math.max(0, next.oldStart - (prev.oldStart + prev.oldCount));
  }
  if (prev.newCount > 0 && next.newCount > 0) {
    return Math.max(0, next.newStart - (prev.newStart + prev.newCount));
  }
  return 0;
}

function renderSegments(segments: InlineDiffSegment[]) {
  let offset = 0;
  return segments.map((seg) => {
    const key = `${offset}:${seg.type}`;
    offset += seg.text.length;
    if (seg.type === 'remove') {
      return (
        <del
          key={key}
          className="rounded-[3px] px-0.5 line-through"
          style={{
            background: 'color-mix(in srgb, var(--semantic-critical) 22%, var(--semantic-critical-surface))',
            color: 'var(--shell-ink)',
          }}
        >
          {seg.text}
        </del>
      );
    }
    if (seg.type === 'add') {
      return (
        <ins
          key={key}
          className="rounded-[3px] px-0.5 font-semibold no-underline"
          style={{
            background: 'color-mix(in srgb, var(--semantic-success) 24%, var(--semantic-success-surface))',
            color: 'var(--shell-ink)',
          }}
        >
          {seg.text}
        </ins>
      );
    }
    return <span key={key}>{seg.text}</span>;
  });
}

function lineStyle(type: ProfileDiffLine['type']) {
  if (type === 'add') {
    return {
      background: 'var(--semantic-success-surface)',
      borderLeftColor: 'var(--semantic-success)',
      color: 'var(--shell-ink)',
    };
  }
  if (type === 'remove') {
    return {
      background: 'var(--semantic-critical-surface)',
      borderLeftColor: 'var(--semantic-critical)',
      color: 'var(--shell-ink)',
    };
  }
  return {
    background: 'transparent',
    borderLeftColor: 'transparent',
    color: 'var(--shell-muted)',
  };
}

function DiffLineRow({
  line,
  showNoNewlineBadge,
  noNewlineLabel,
}: {
  line: ProfileDiffLine;
  showNoNewlineBadge: boolean;
  noNewlineLabel: string;
}) {
  const lineNumber = line.type === 'remove' ? line.oldLine : line.newLine;
  const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' ';

  return (
    <div
      data-diff-line={line.type}
      className="grid grid-cols-[2.25rem_1rem_minmax(0,1fr)] items-baseline border-l-2 px-2 py-0.5 font-mono text-xs leading-5"
      style={lineStyle(line.type)}
    >
      <span className="select-none pr-1.5 text-right text-label text-[var(--shell-muted)]">{lineNumber ?? ''}</span>
      <span aria-hidden="true" className="select-none text-center text-[var(--shell-muted)]">
        {prefix}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words">
        {line.segments ? renderSegments(line.segments) : line.content || '\u00a0'}
        {showNoNewlineBadge ? (
          <span className="ml-1.5 inline-block rounded border border-[var(--shell-hairline)] bg-[var(--shell-work)] px-1 font-sans text-label text-[var(--shell-muted)]">
            {noNewlineLabel}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function ProfileDiffView({ before, after }: { before: string; after: string }) {
  const t = useShellCopy(originalApprovalCopy);
  const diff = useMemo(() => computeProfileLineDiff(before, after, { contextLines: 1 }), [before, after]);

  const summary = diff.identical
    ? t.diffIdentical
    : diff.initialWrite
      ? t.diffInitial(diff.addedLineCount)
      : t.diffCounts(diff.addedLineCount, diff.removedLineCount);

  return (
    <section
      data-testid="profile-update-diff"
      aria-label={t.diffTitle}
      className="overflow-hidden rounded-lg border border-[var(--shell-hairline)] bg-[var(--shell-paper)]"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--shell-hairline)] bg-[var(--shell-work)] px-2.5 py-1.5 text-xs">
        <span className="font-medium text-[var(--shell-ink)]">{t.diffTitle}</span>
        <span className="font-mono text-[var(--shell-muted)]">{summary}</span>
      </header>
      {diff.identical ? (
        <p className="px-2.5 py-2 text-xs text-[var(--shell-muted)]">{t.diffIdentical}</p>
      ) : (
        <div
          // biome-ignore lint/a11y/noNoninteractiveTabindex: bounded diff scroll region supports keyboard scrolling
          tabIndex={0}
          className="max-h-80 overflow-y-auto py-0.5"
        >
          {diff.hunks.map((hunk, hi) => {
            const prev = hi > 0 ? diff.hunks[hi - 1] : undefined;
            const omitted = prev ? omittedCountBetween(prev, hunk) : 0;
            const eofChanged =
              hunk.lines.some((line) => line.noNewlineAtEof) &&
              hunk.lines.some((line) => line.type !== 'context' && !line.noNewlineAtEof);
            return (
              <div key={`${hunk.oldStart}:${hunk.newStart}`}>
                {omitted > 0 ? (
                  <div className="border-y border-[var(--shell-hairline)] bg-[var(--shell-work)] px-2.5 py-0.5 font-mono text-label text-[var(--shell-muted)]">
                    {t.diffOmittedLines(omitted)}
                  </div>
                ) : null}
                {hunk.lines.map((line) => (
                  <DiffLineRow
                    key={`${line.type}:${line.oldLine ?? 'n'}:${line.newLine ?? 'o'}`}
                    line={line}
                    showNoNewlineBadge={Boolean(line.noNewlineAtEof && eofChanged)}
                    noNewlineLabel={t.diffNoNewline}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
