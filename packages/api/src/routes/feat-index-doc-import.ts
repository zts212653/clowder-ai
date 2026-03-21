import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseActiveFeaturesFromBacklog } from './backlog-doc-import.js';

export interface FeatIndexEntry {
  featId: string;
  name: string;
  status: string;
  keyDecisions?: string[];
}

interface FeatureDocEntry {
  featId: string;
  name?: string;
  status?: string;
  keyDecisions?: string[];
}

function findMonorepoRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

function normalizeFeatId(value: string): string {
  return value.trim().toUpperCase();
}

function isFeatId(value: string): boolean {
  return /^F\d{3}$/.test(value);
}

function extractFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const parsed = parseYaml(match[1] ?? '');
    const frontmatter = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    return { frontmatter, body: content.slice((match[0] ?? '').length) };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function extractHeadingTitle(body: string): string | undefined {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (!heading) return undefined;
  return heading.replace(/^F\d{3}\s*:\s*/i, '').trim();
}

function extractStatusFromBody(body: string): string | undefined {
  const match = body.match(/^>\s*\*\*Status\*\*:\s*(.+)$/im)?.[1]?.trim();
  if (!match) return undefined;
  return match.replace(/^`|`$/g, '').trim();
}

function extractFeatureIds(frontmatter: Record<string, unknown>, fallbackFileName: string): string[] {
  const ids: string[] = [];
  const raw = frontmatter.feature_ids;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const normalized = normalizeFeatId(item);
      if (isFeatId(normalized)) ids.push(normalized);
    }
  }

  if (ids.length > 0) return ids;

  const fallback = normalizeFeatId(fallbackFileName.match(/(F\d{3})/)?.[1] ?? '');
  if (isFeatId(fallback)) return [fallback];
  return [];
}

function extractKeyDecisions(frontmatter: Record<string, unknown>): string[] | undefined {
  const value = frontmatter.keyDecisions;
  if (!Array.isArray(value)) return undefined;
  const decisions = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return decisions.length > 0 ? decisions : undefined;
}

async function readFeatureDocEntries(featuresDir: string): Promise<FeatureDocEntry[]> {
  if (!existsSync(featuresDir)) return [];
  let fileNames: string[] = [];
  try {
    fileNames = readdirSync(featuresDir).filter((name) => /\.md$/i.test(name));
  } catch {
    return [];
  }

  const entries: FeatureDocEntry[] = [];
  for (const fileName of fileNames) {
    const filePath = join(featuresDir, fileName);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    const { frontmatter, body } = extractFrontmatter(raw);
    const featureIds = extractFeatureIds(frontmatter, fileName);
    if (featureIds.length === 0) continue;

    const name = pickString(frontmatter, ['name', 'title']) ?? extractHeadingTitle(body);
    const status = pickString(frontmatter, ['status']) ?? extractStatusFromBody(body);
    const keyDecisions = extractKeyDecisions(frontmatter);

    for (const featId of featureIds) {
      entries.push({
        featId,
        ...(name ? { name } : {}),
        ...(status ? { status } : {}),
        ...(keyDecisions ? { keyDecisions } : {}),
      });
    }
  }

  return entries;
}

function toSortedEntries(entries: FeatIndexEntry[]): FeatIndexEntry[] {
  return entries.sort((a, b) => {
    const left = Number.parseInt(a.featId.slice(1), 10);
    const right = Number.parseInt(b.featId.slice(1), 10);
    return left - right;
  });
}

export async function readFeatIndexEntries(): Promise<FeatIndexEntry[]> {
  const root = findMonorepoRoot();
  const featuresDir = join(root, 'docs', 'features');
  const backlogPath = join(root, 'docs', 'ROADMAP.md');

  const docEntries = await readFeatureDocEntries(featuresDir);
  const map = new Map<string, FeatureDocEntry>();
  for (const entry of docEntries) {
    map.set(entry.featId, {
      featId: entry.featId,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.status ? { status: entry.status } : {}),
      ...(entry.keyDecisions ? { keyDecisions: entry.keyDecisions } : {}),
    });
  }

  if (existsSync(backlogPath)) {
    try {
      const backlog = await readFile(backlogPath, 'utf-8');
      const backlogRows = parseActiveFeaturesFromBacklog(backlog);
      for (const row of backlogRows) {
        const current = map.get(row.id);
        if (!current) {
          map.set(row.id, {
            featId: row.id,
            name: row.name,
            status: row.status,
          });
          continue;
        }

        map.set(row.id, {
          featId: row.id,
          ...(current.name ? { name: current.name } : { name: row.name }),
          ...(current.status ? { status: current.status } : { status: row.status }),
          ...(current.keyDecisions ? { keyDecisions: current.keyDecisions } : {}),
        });
      }
    } catch {
      // Ignore unreadable BACKLOG.md and keep feature-doc-only entries.
    }
  }

  const merged: FeatIndexEntry[] = [];
  for (const [featId, entry] of map.entries()) {
    merged.push({
      featId,
      name: entry.name ?? featId,
      status: entry.status ?? 'spec',
      ...(entry.keyDecisions ? { keyDecisions: entry.keyDecisions } : {}),
    });
  }

  return toSortedEntries(merged);
}
