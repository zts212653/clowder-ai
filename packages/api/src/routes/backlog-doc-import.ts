import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BacklogDependencies,
  BacklogPriority,
  BacklogStatus,
  CreateBacklogItemInput,
  FeatureDocAC,
  FeatureDocPhase,
  FeatureDocRisk,
} from '@cat-cafe/shared';
import { gitListFeatureDocs, readBacklogContent, readFeatureDocContent } from './git-doc-reader.js';

export interface BacklogFeatureRow {
  id: string;
  name: string;
  status: string;
  owner: string;
  link?: string;
}

function parseTableCells(line: string): string[] {
  const normalized = line.trim();
  if (!normalized.startsWith('|')) return [];
  const body = normalized.endsWith('|') ? normalized.slice(1, -1) : normalized.slice(1);
  return body.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function extractLink(linkCell: string): string | undefined {
  const match = linkCell.match(/\[[^\]]+\]\(([^)]+)\)/);
  return match?.[1]?.trim() || undefined;
}

export function parseActiveFeaturesFromBacklog(markdown: string): BacklogFeatureRow[] {
  const lines = markdown.split(/\r?\n/);
  const requiredColumns = ['id', '名称', 'status', 'owner'];
  const headerIndex = lines.findIndex((line) => {
    if (!line.trim().startsWith('|')) return false;
    const cells = parseTableCells(line);
    const lowerCells = cells.map((c) => c.trim().toLowerCase());
    return requiredColumns.every((col) => lowerCells.includes(col));
  });
  if (headerIndex < 0) {
    throw new Error(
      `BACKLOG.md missing required columns: ${requiredColumns.join(', ')}. ` +
        'Refusing to proceed — an empty parse result would cause sync to mark all features as done.',
    );
  }

  const headerCells = parseTableCells(lines[headerIndex]!);
  const colIndex = new Map<string, number>();
  for (const [i, cell] of headerCells.entries()) {
    colIndex.set(cell.trim().toLowerCase(), i);
  }
  const idCol = colIndex.get('id')!;
  const nameCol = colIndex.get('名称')!;
  const statusCol = colIndex.get('status')!;
  const ownerCol = colIndex.get('owner')!;
  const linkCol = colIndex.get('link');

  const rows: BacklogFeatureRow[] = [];
  const seen = new Set<string>();
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (line.length === 0) continue;
    if (!line.startsWith('|')) break;

    const cells = parseTableCells(line);
    if (cells.length < requiredColumns.length || isSeparatorRow(cells)) continue;

    const id = cells[idCol]?.trim().toUpperCase() ?? '';
    if (!/^F\d{3}$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const link = linkCol != null ? extractLink(cells[linkCol] ?? '') : undefined;
    rows.push({
      id,
      name: cells[nameCol]?.trim() ?? '',
      status: cells[statusCol]?.trim() ?? 'idea',
      owner: cells[ownerCol]?.trim() ?? '三猫',
      ...(link ? { link } : {}),
    });
  }

  return rows;
}

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase().replace(/\s+/g, '-');
}

function statusToPriority(status: string): BacklogPriority {
  switch (normalizeStatus(status)) {
    case 'in-progress':
    case 'review':
      return 'p1';
    case 'spec':
      return 'p2';
    default:
      return 'p3';
  }
}

/** Map BACKLOG.md feature status to BacklogItem workflow status. */
export function featureStatusToBacklogStatus(featureStatus: string): BacklogStatus {
  const normalized = normalizeStatus(featureStatus);
  if (normalized === 'done') return 'done';
  if (normalized === 'in-progress' || normalized === 'in-review') return 'dispatched';
  // "done (Phase 1)" etc. — still actively working, treat as dispatched
  if (normalized.startsWith('done-')) return 'dispatched';
  return 'open';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function buildBacklogInputFromFeature(
  row: BacklogFeatureRow,
  userId: string,
  dependencies?: BacklogDependencies,
): CreateBacklogItemInput {
  const title = truncate(`[${row.id}] ${row.name}`, 200);
  const summarySegments = [
    '来源 docs/ROADMAP.md',
    `状态：${row.status}`,
    `Owner：${row.owner}`,
    row.link ? `Link：${row.link}` : null,
  ].filter(Boolean);
  const summary = truncate(summarySegments.join(' | '), 2000);
  const statusTag = normalizeStatus(row.status) || 'idea';
  const mappedStatus = featureStatusToBacklogStatus(row.status);

  return {
    userId,
    title,
    summary,
    priority: statusToPriority(row.status),
    tags: ['source:docs-backlog', `feature:${row.id.toLowerCase()}`, `status:${statusTag}`],
    createdBy: 'user',
    ...(dependencies && Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    ...(mappedStatus !== 'open' ? { initialStatus: mappedStatus } : {}),
  };
}

export function getFeatureTagId(tags: readonly string[]): string | null {
  for (const tag of tags) {
    if (tag.startsWith('feature:')) return tag.slice('feature:'.length).toLowerCase();
  }
  return null;
}

export function parseFeatureDocStatus(markdown: string): string | null {
  // Prefer body status (> **Status**: xxx)
  const bodyMatch = markdown.match(/>\s*\*\*Status\*\*:\s*(\w[\w\s-]*)/i);
  if (bodyMatch?.[1]) return bodyMatch[1].trim().toLowerCase();
  // Fallback: YAML frontmatter `status:` field
  const fmMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const statusMatch = fmMatch[1]?.match(/^status:\s*(.+)/m);
    if (statusMatch?.[1]) return statusMatch[1].trim().toLowerCase();
  }
  return null;
}

/** Extract feature name from heading like `# F049: Mission Hub — Backlog Center(...)` */
export function parseFeatureDocName(markdown: string): string | null {
  const match = markdown.match(/^#\s+F\d{3}:\s*(.+)/m);
  return match?.[1]?.trim() ?? null;
}

/** Extract owner from `> **Owner**: 三猫` */
export function parseFeatureDocOwner(markdown: string): string {
  const match = markdown.match(/>\s*\*\*Owner\*\*:\s*(.+)/i);
  return match?.[1]?.trim() ?? '三猫';
}

function extractFeatureIds(text: string): string[] {
  return [...text.matchAll(/F\d{3}/gi)].map((m) => m[0].toLowerCase());
}

function extractFrontmatterRelated(markdown: string): string[] {
  const fmMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const relatedMatch = fmMatch[1]?.match(/related_features:\s*\[([^\]]*)\]/);
  if (!relatedMatch) return [];
  // Use extractFeatureIds to normalize — rejects non-F\d{3} values like "F32-b"
  return extractFeatureIds(relatedMatch[1] ?? '');
}

const PLACEHOLDER_RE = /^(无|待定|tbd|n\/a|—|-)$/i;

function extractBodyDeps(markdown: string) {
  const evolvedFrom: string[] = [];
  const blockedBy: string[] = [];
  const related: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (/\*\*Evolved from\*\*/i.test(line)) evolvedFrom.push(...extractFeatureIds(line));
    if (/\*\*Blocked by\*\*/i.test(line)) blockedBy.push(...extractFeatureIds(line));
    if (/\*\*Related\*\*/i.test(line)) {
      const afterColon = line.replace(/.*\*\*Related\*\*\s*[:：]?\s*/i, '').trim();
      if (!PLACEHOLDER_RE.test(afterColon)) related.push(...extractFeatureIds(line));
    }
  }
  return { evolvedFrom, blockedBy, related };
}

export function parseFeatureDocDependencies(markdown: string): BacklogDependencies {
  const fmRelated = extractFrontmatterRelated(markdown);
  const body = extractBodyDeps(markdown);
  const allRelated = [...fmRelated, ...body.related];

  const specialized = new Set([...body.evolvedFrom, ...body.blockedBy]);
  const dedupRelated = [...new Set(allRelated)].filter((id) => !specialized.has(id));
  const dedupEvolved = [...new Set(body.evolvedFrom)];
  const dedupBlocked = [...new Set(body.blockedBy)];

  return {
    ...(dedupEvolved.length > 0 ? { evolvedFrom: dedupEvolved } : {}),
    ...(dedupBlocked.length > 0 ? { blockedBy: dedupBlocked } : {}),
    ...(dedupRelated.length > 0 ? { related: dedupRelated } : {}),
  };
}

export function parseFeatureDocPhases(markdown: string): FeatureDocPhase[] {
  const phaseRegex = /^###\s+Phase\s+([A-Z])[\s:：]+(.+)/gim;
  const phases: Array<{ id: string; name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = phaseRegex.exec(markdown)) !== null) {
    const id = m[1];
    const name = m[2];
    if (id && name) phases.push({ id: id.toUpperCase(), name: name.trim() });
  }
  if (phases.length === 0) return [];

  const acLineRegex = /^-\s+\[([ xX])\]\s+(AC-([A-Z])\d+)[:\s：]+(.+)/gm;
  const acsByPhase = new Map<string, FeatureDocAC[]>();
  while ((m = acLineRegex.exec(markdown)) !== null) {
    const checkbox = m[1];
    const acId = m[2];
    const phaseChar = m[3];
    const acText = m[4];
    if (!checkbox || !acId || !phaseChar || !acText) continue;
    const phaseId = phaseChar.toUpperCase();
    const list = acsByPhase.get(phaseId) ?? [];
    list.push({ id: acId, text: acText.trim(), done: checkbox.toLowerCase() === 'x' });
    acsByPhase.set(phaseId, list);
  }

  return phases.map((p) => ({ id: p.id, name: p.name, acs: acsByPhase.get(p.id) ?? [] }));
}

export function parseFeatureDocRisks(markdown: string): FeatureDocRisk[] {
  const sections = markdown.split(/^(?=##\s)/m);
  const riskSection = sections.find((s) => /^##\s*Risk/i.test(s));
  if (!riskSection) return [];
  const rows = riskSection.split('\n').filter((l) => l.startsWith('|'));
  const headerSkipped = rows.slice(rows.findIndex((r) => r.includes('---')) + 1);
  return headerSkipped
    .map((row) => {
      const cells = row
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length < 2) return null;
      const risk = cells[0];
      const mitigation = cells[cells.length - 1];
      return risk && mitigation ? { risk, mitigation } : null;
    })
    .filter((r): r is FeatureDocRisk => r !== null);
}

interface FeatureDocEntry {
  entry: string;
  featureId: string;
  content: string;
}

async function listLocalFeatureDocs(dir: string): Promise<FeatureDocEntry[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const results: FeatureDocEntry[] = [];
  for (const entry of files) {
    const match = entry.match(/^(F\d{3})/i);
    if (!match) continue;
    try {
      const content = await readFile(join(dir, entry), 'utf-8');
      results.push({ entry, featureId: match[1]?.toLowerCase() ?? '', content });
    } catch {
      /* skip */
    }
  }
  return results;
}

async function listRemoteFeatureDocs(): Promise<FeatureDocEntry[]> {
  const entries = await gitListFeatureDocs();
  const results: FeatureDocEntry[] = [];
  for (const entry of entries) {
    const match = entry.match(/^(F\d{3})/i);
    if (!match) continue;
    const content = await readFeatureDocContent(entry);
    if (content) results.push({ entry, featureId: match[1]?.toLowerCase() ?? '', content });
  }
  return results;
}

function getFeatureDocs(featuresDir?: string): Promise<FeatureDocEntry[]> {
  return featuresDir ? listLocalFeatureDocs(featuresDir) : listRemoteFeatureDocs();
}

export async function readFeatureDocStatuses(featuresDir?: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const { featureId, content } of await getFeatureDocs(featuresDir)) {
    const status = parseFeatureDocStatus(content);
    if (status) result.set(featureId, status);
  }
  return result;
}

export async function readFeatureDocDependencies(featuresDir?: string): Promise<Map<string, BacklogDependencies>> {
  const result = new Map<string, BacklogDependencies>();
  for (const { featureId, content } of await getFeatureDocs(featuresDir)) {
    const deps = parseFeatureDocDependencies(content);
    if (Object.keys(deps).length > 0) result.set(featureId, deps);
  }
  return result;
}

export async function readActiveFeaturesFromBacklog(backlogDocPath?: string): Promise<BacklogFeatureRow[]> {
  if (backlogDocPath) {
    const markdown = await readFile(backlogDocPath, 'utf-8');
    return parseActiveFeaturesFromBacklog(markdown);
  }
  const markdown = await readBacklogContent();
  return parseActiveFeaturesFromBacklog(markdown);
}

/**
 * Read docs/features/*.md and return BacklogFeatureRow[] for features
 * whose status is "done" (historical features not in BACKLOG.md).
 * Excludes features already present in `excludeIds`.
 */
export async function readDoneFeatureDocsAsRows(
  excludeIds: Set<string>,
  featuresDir?: string,
): Promise<BacklogFeatureRow[]> {
  const rows: BacklogFeatureRow[] = [];
  for (const { entry, featureId, content } of await getFeatureDocs(featuresDir)) {
    const upperId = featureId.toUpperCase();
    if (excludeIds.has(featureId)) continue;
    const status = parseFeatureDocStatus(content);
    if (status !== 'done') continue;
    const name = parseFeatureDocName(content) ?? entry.replace(/\.md$/, '');
    const owner = parseFeatureDocOwner(content);
    rows.push({ id: upperId, name, status: 'done', owner, link: `features/${entry}` });
  }
  return rows;
}
