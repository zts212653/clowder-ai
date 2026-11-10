// Pure helpers for scripts/doc-sync-candidates.mjs (daily doc guard).
// Keep this file free of git/gh calls so the rules can be unit tested.
// See docs/ops/daily-doc-sync.md for how the daily guard uses the output.

const FEATURE_RE = /(?<![A-Za-z0-9#])[Ff](\d{3})(?!\d)/g;
// A disposition is its own line with a real reason: "Doc-Sync: none - reason", or
// "Doc-Sync: F332 - recorded in <commit>" when the doc was updated without naming the PR.
// An optional list bullet is allowed; quotes, inline examples and placeholders are not.
const DOC_SYNC_LINE_RE =
  /^\s*(?:[-*]\s+)?Doc-Sync:\s*(?:none|F\d{3}(?:\s*[,/]\s*F\d{3})*)\s*(?:\u2014|\u2013|-|:)+\s*(\S.*)$/i;
const WEAK_BODY_LINK_LIMIT = 3;

export function extractFeatureIds(text, known) {
  const ids = new Set();
  for (const match of String(text ?? '').matchAll(FEATURE_RE)) {
    const id = `F${match[1]}`;
    if (!known || known.has(id)) ids.add(id);
  }
  return [...ids].sort();
}

// Title wins; body and branch are a weaker fallback because PR bodies often
// mention neighbouring features. A body link to many features is marked weak.
export function linkPrToFeatures(pr, known) {
  const fromTitle = extractFeatureIds(pr.title, known);
  if (fromTitle.length > 0) return { features: fromTitle, source: 'title', weak: false };
  const fromBody = extractFeatureIds(`${pr.body ?? ''}\n${pr.headRefName ?? ''}`, known);
  if (fromBody.length > 0) {
    return { features: fromBody, source: 'body', weak: fromBody.length > WEAK_BODY_LINK_LIMIT };
  }
  return { features: [], source: 'none', weak: false };
}

export function textHasDocSyncLine(text) {
  let fenced = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const reason = DOC_SYNC_LINE_RE.exec(line)?.[1]?.trim() ?? '';
    if (reason && !reason.startsWith('<')) return true;
  }
  return false;
}

export function hasDocSyncLine(pr) {
  if (textHasDocSyncLine(pr.body)) return true;
  return (pr.comments ?? []).some((comment) => textHasDocSyncLine(comment?.body));
}

export function prTouchesFeatureDoc(pr, featureId) {
  const prefix = `docs/features/${featureId}-`;
  return (pr.files ?? []).some((file) => String(file?.path ?? '').startsWith(prefix));
}

// Split `git log --format=@@COMMIT %h%n%B -p --unified=0` output (one feature doc)
// into commits that name this PR (number or merge commit) and commits that do not.
// Only the commit message and added lines count; a later unrelated edit is a hint.
export function docCommitsForPr(patchText, prNumber, mergeOid) {
  const prRe = new RegExp(`(?<![0-9A-Za-z])(?:#|pull/)${prNumber}(?!\\d)`);
  const oid = String(mergeOid ?? '').slice(0, 7);
  const oidRe = oid.length === 7 ? new RegExp(`(?<![0-9a-f])${oid}`) : null;
  const names = (text) => prRe.test(text) || (oidRe ? oidRe.test(text) : false);
  const provenance = [];
  const other = [];
  for (const block of String(patchText ?? '')
    .split('@@COMMIT ')
    .slice(1)) {
    const [head, ...rest] = block.split('\n');
    const diffAt = rest.findIndex((line) => line.startsWith('diff --git'));
    const message = (diffAt < 0 ? rest : rest.slice(0, diffAt)).join('\n');
    const added = (diffAt < 0 ? [] : rest.slice(diffAt)).filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    (names(message) || added.some(names) ? provenance : other).push(head.trim());
  }
  return { provenance, other };
}

export function statusToken(raw) {
  const plain = String(raw ?? '')
    .replace(/[*`]/g, '')
    .trim()
    .toLowerCase();
  const match = /^[a-z][a-z0-9_-]*/.exec(plain);
  return match ? match[0] : '';
}

const PRE = new Set(['spec', 'idea', 'design', 'draft', 'spike', 'proposed', 'planning', 'todo']);
const ACTIVE = new Set(['in-progress', 'doing', 'implementation', 'review', 'wip', 'active', 'reopened']);
const TERMINAL = new Set(['done', 'closed', 'failed-close', 'absorbed', 'complete', 'completed', 'shipped']);

export function statusClass(token) {
  if (!token) return 'unknown';
  if (PRE.has(token)) return 'pre';
  if (ACTIVE.has(token) || token.startsWith('phase')) return 'active';
  if (TERMINAL.has(token) || token.startsWith('merged') || token.startsWith('done')) return 'terminal';
  if (token === 'parked' || token === 'paused') return 'parked';
  return 'unknown';
}

export function parseStatusLine(docText) {
  const match = />\s*\*\*Status\*\*:\s*([^\n<>|]+)/i.exec(String(docText ?? ''));
  return match ? match[1].trim() : null;
}

export function parseBacklogRows(markdown) {
  const rows = [];
  for (const line of String(markdown ?? '').split('\n')) {
    if (!/^\|\s*F\d{3}\s*\|/.test(line)) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());
    const link = /\(features\/(F\d{3}-[^)\s]+\.md)\)/.exec(line);
    rows.push({
      id: cells[0],
      status: cells[2] ?? '',
      docPath: link ? `docs/features/${link[1]}` : null,
      line: line.trim(),
    });
  }
  return rows;
}

// Compare the BACKLOG row status with the feature doc Status line.
// Only class-level contradictions are reported; wording variants
// (phase-a-done vs in-progress) are left to the row-age check.
export function backlogStatusFinding(row, docStatusRaw) {
  if (docStatusRaw == null) return null;
  const rowToken = statusToken(row.status);
  const docToken = statusToken(docStatusRaw);
  const rowClass = statusClass(rowToken);
  const docClass = statusClass(docToken);
  if (docClass === 'terminal') {
    return { kind: 'terminal-still-listed', rowToken, docToken };
  }
  if (rowClass === 'unknown' || docClass === 'unknown' || rowClass === docClass) return null;
  return { kind: 'status-class-mismatch', rowToken, docToken };
}

function changedFeature(line, mode, fileFeature) {
  if (!/^[+-](?![+-])/.test(line)) return null;
  if (mode === 'backlog') return /^[+-]\|\s*(F\d{3})\s*\|/.exec(line)?.[1] ?? null;
  if (mode === 'status' && fileFeature && /^[+-]>\s*\*\*Status\*\*/.test(line)) return fileFeature;
  return null;
}

// Parse `git log --format=@@COMMIT %ct -p --unified=0` output (newest first)
// and return the latest change time per feature.
//   mode 'backlog': changed lines that are BACKLOG rows `| Fxxx |`
//   mode 'status' : changed `> **Status**:` lines inside docs/features/Fxxx-*.md
export function latestChangeByFeature(patchText, mode) {
  const latest = new Map();
  let commitTs = 0;
  let fileFeature = null;
  for (const line of String(patchText ?? '').split('\n')) {
    if (line.startsWith('@@COMMIT ')) {
      commitTs = Number(line.slice(9).trim()) || 0;
      fileFeature = null;
    } else if (line.startsWith('+++ ')) {
      fileFeature = /docs\/features\/(F\d{3})-/.exec(line)?.[1] ?? null;
    } else {
      const featureId = changedFeature(line, mode, fileFeature);
      if (featureId && !latest.has(featureId)) latest.set(featureId, commitTs);
    }
  }
  return latest;
}
