// Ledger and report helpers for scripts/doc-sync-candidates.mjs (pure, no IO).
// Ledger file: docs/ops/doc-sync-dispositions.json (edited on main only).
//   lastScanAt  - ISO time of the last scan that wrote the ledger
//   openPrs     - PRs found without doc follow-up (with or without a feature id);
//                 they stay until a doc commit names them or a Doc-Sync line disposes them
//   backlogRows - rows the duty cat verified; bound to the whole row, the linked
//                 doc path and its Status text, so any later change reopens the row

import { createHash } from 'node:crypto';

const DAY_MS = 86400000;
const OVERLAP_MS = 3600000;

export function normalizeLedger(json) {
  const ledger = json && typeof json === 'object' ? json : {};
  return {
    schemaVersion: 2,
    about: ledger.about ?? '',
    lastScanAt: typeof ledger.lastScanAt === 'string' ? ledger.lastScanAt : null,
    openPrs: ledger.openPrs && typeof ledger.openPrs === 'object' ? ledger.openPrs : {},
    backlogRows: ledger.backlogRows && typeof ledger.backlogRows === 'object' ? ledger.backlogRows : {},
  };
}

// Discovery window: at least `days`, and back to the last scan if scans stopped.
export function scanStart(ledger, nowMs, days) {
  const byDays = nowMs - days * DAY_MS;
  const last = Date.parse(ledger.lastScanAt ?? '');
  return Number.isFinite(last) && last - OVERLAP_MS < byDays ? last - OVERLAP_MS : byDays;
}

// evaluated: Map<number, { missing: boolean, features: string[] }> for every PR
// looked at this run (window plus carried-over open PRs).
export function nextOpenPrs(prevOpen, evaluated, nowIso) {
  const next = {};
  for (const [number, entry] of Object.entries(prevOpen ?? {})) {
    const seen = evaluated.get(Number(number));
    if (!seen) next[number] = entry;
    else if (seen.missing) next[number] = { ...entry, features: seen.features };
  }
  for (const [number, seen] of evaluated) {
    if (seen.missing && !next[String(number)]) next[String(number)] = { firstSeenAt: nowIso, features: seen.features };
  }
  return next;
}

export function textHash(text) {
  return createHash('sha256')
    .update(String(text ?? ''))
    .digest('hex')
    .slice(0, 16);
}

// Bound to the whole BACKLOG row, the doc it links and that doc's Status text.
export function rowDisposition(row, docPath, docStatus, note, nowIso) {
  return { checkedAt: nowIso, note, docPath, rowHash: textHash(row.line), docStatusHash: textHash(docStatus ?? '') };
}

export function rowDisposed(entry, row, docPath, docStatus) {
  return Boolean(
    entry &&
      entry.docPath === docPath &&
      entry.rowHash === textHash(row.line) &&
      entry.docStatusHash === textHash(docStatus ?? ''),
  );
}

function stamp(ts) {
  return ts ? new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'over 180 days ago';
}

function laterDocHint(commits) {
  if (!commits?.length) return '';
  const shown = commits.slice(0, 3).join(',');
  const more = commits.length > 3 ? ` +${commits.length - 3} more` : '';
  return ` -- doc changed later (${shown}${more}), check coverage`;
}

function prLine(item) {
  const how = `${item.source}${item.weak ? ', weak link' : ''}`;
  const carried = item.carried ? ` [open since ${item.firstSeenAt}]` : '';
  return `- #${item.number} ${item.mergedAt} ${item.features.join(',')} (from ${how})${carried} ${item.title}${laterDocHint(item.otherDocCommits)}`;
}

function backlogLine(item) {
  if (item.kind === 'row-older-than-status') {
    return `- ${item.id} row-older-than-status: Status ${stamp(item.statusAt)}, row ${stamp(item.rowAt)}`;
  }
  if (item.rowToken !== undefined)
    return `- ${item.id} ${item.kind}: BACKLOG "${item.rowToken}" vs doc "${item.docToken}"`;
  return `- ${item.id} ${item.kind}: ${item.path}`;
}

function section(title, items, toLine) {
  return items.length === 0 ? [] : ['', title, ...items.map(toLine)];
}

export function hasCandidates(report) {
  return report.prs.missing.length + report.backlog.findings.length + report.prs.unlinked.length > 0;
}

export function render(report) {
  const { prs, backlog } = report;
  const lines = [
    `# Doc sync candidates (${report.ref} ${report.head}, merged since ${report.since})`,
    '',
    `Merged PRs: ${report.prCount} (+${report.carriedCount} open from ledger); feature-linked ${prs.linked}, ` +
      `handled ${prs.handled}, missing doc follow-up ${prs.missing.length}; without feature id ${prs.unlinked.length}.`,
    `BACKLOG active rows: ${backlog.rows}; findings ${backlog.findings.length} (${backlog.disposed} disposed).`,
  ];
  if (report.truncatedDays.length > 0) {
    lines.push(`INCOMPLETE: PR list hit the limit on ${report.truncatedDays.join(', ')}; rerun with a shorter window.`);
  }
  if (!hasCandidates(report)) return [...lines, '', 'No candidates.'].join('\n');
  return [
    ...lines,
    ...section('## Merged with a feature id, no doc follow-up naming the PR, no Doc-Sync note', prs.missing, prLine),
    ...section('## BACKLOG rows to check', backlog.findings, backlogLine),
    ...section(
      '## Merged without any feature id, no Doc-Sync line (check if user-visible)',
      prs.unlinked,
      (item) =>
        `- #${item.number} ${item.mergedAt}${item.carried ? ` [open since ${item.firstSeenAt}]` : ''} ${item.title}`,
    ),
  ].join('\n');
}
