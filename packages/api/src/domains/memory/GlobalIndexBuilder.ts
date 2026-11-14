/**
 * F102 Phase F-4: GlobalIndexBuilder
 * Compiles global knowledge sources (Skills + MEMORY.md entries) into
 * a read-only SqliteEvidenceStore for federated search via KnowledgeResolver.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type FrontmatterPair,
  readFrontmatterPairs,
  readMarkdownFrontmatter,
} from '@cat-cafe/shared/markdown-frontmatter';
import type { EvidenceItem, EvidenceKind, RebuildResult } from './interfaces.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';

/** Memory type → EvidenceKind mapping */
const MEMORY_KIND_MAP: Record<string, EvidenceKind> = {
  feedback: 'lesson',
  project: 'plan',
  reference: 'plan',
  user: 'lesson',
};

export interface GlobalIndexConfig {
  skillsRoot: string;
  memoryRoot: string;
  globalStore: SqliteEvidenceStore;
  /** F263 W5: local-only projection for personal memory; never federated into global:methods. */
  personalStore?: SqliteEvidenceStore;
  /** F152 Phase C: directory containing materialized distilled truth .md files. */
  distilledRoot?: string;
}

export interface GlobalPrivacyAudit {
  personalSources: number;
  purgedFromGlobal: number;
  reLayeredPrivate: number;
}

export interface GlobalRebuildResult extends RebuildResult {
  privacyAudit: GlobalPrivacyAudit;
}

export class GlobalIndexBuilder {
  private rebuildInFlight: Promise<GlobalRebuildResult> | null = null;
  private readonly skillsRoot: string;
  private readonly memoryRoot: string;
  private readonly store: SqliteEvidenceStore;
  private readonly personalStore?: SqliteEvidenceStore;
  private readonly distilledRoot?: string;

  constructor(config: GlobalIndexConfig) {
    this.skillsRoot = config.skillsRoot;
    this.memoryRoot = config.memoryRoot;
    this.store = config.globalStore;
    this.personalStore = config.personalStore;
    this.distilledRoot = config.distilledRoot;
  }

  rebuild(): Promise<GlobalRebuildResult> {
    if (this.rebuildInFlight) return this.rebuildInFlight;
    const work = this.rebuildOnce().finally(() => {
      if (this.rebuildInFlight === work) this.rebuildInFlight = null;
    });
    this.rebuildInFlight = work;
    return work;
  }

  private async rebuildOnce(): Promise<GlobalRebuildResult> {
    const start = Date.now();
    const memories = await this.discoverMemories();
    const distilled = await this.discoverDistilledTruths();
    const items = [...(await this.discoverSkills()), ...memories.global, ...distilled];

    // Privacy-first order: purge stale/global-personal rows before writing the private
    // projection. A crash may reduce recall availability, but cannot retain the leak.
    const freshAnchors = new Set(items.map((i) => i.anchor));
    const personalGlobalAnchors = new Set(memories.personal.map((entry) => entry.globalAnchor));
    let purgedFromGlobal = 0;
    const db = this.store.getDb();
    if (db) {
      const existing = db.prepare('SELECT anchor FROM evidence_docs').all() as Array<{ anchor: string }>;
      for (const row of existing) {
        if (!freshAnchors.has(row.anchor)) {
          await this.store.deleteByAnchor(row.anchor);
          if (personalGlobalAnchors.has(row.anchor)) purgedFromGlobal++;
        }
      }
    }

    if (items.length > 0) await this.store.upsert(items);

    let reLayeredPrivate = 0;
    if (this.personalStore) {
      const personalItems = memories.personal.map((entry) => entry.item);
      await replaceStoreProjection(this.personalStore, personalItems);
      reLayeredPrivate = personalItems.length;
    }

    return {
      docsIndexed: items.length,
      docsSkipped: memories.personal.length,
      durationMs: Date.now() - start,
      privacyAudit: {
        personalSources: memories.personal.length,
        purgedFromGlobal,
        reLayeredPrivate,
      },
    };
  }

  // ── Skills discovery ──────────────────────────────────────────────

  private async discoverSkills(): Promise<EvidenceItem[]> {
    if (!existsSync(this.skillsRoot)) return [];
    const items: EvidenceItem[] = [];

    for (const entry of await readdir(this.skillsRoot, { withFileTypes: true })) {
      if (entry.name === 'refs') {
        items.push(...(await this.indexDir(join(this.skillsRoot, 'refs'), 'decision', 'global:ref')));
        continue;
      }
      if (!entry.isDirectory()) continue;

      const skillPath = join(this.skillsRoot, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;

      const content = await readFile(skillPath, 'utf-8');
      const fm = readFrontmatter(content)?.data;
      items.push({
        anchor: `global:skill/${entry.name}`,
        kind: 'plan',
        status: 'active',
        title: text(fm?.name) ?? entry.name,
        summary: text(fm?.description) ?? content.slice(0, 300),
        updatedAt: (await stat(skillPath)).mtime.toISOString(),
      });
    }
    return items;
  }

  // ── Memory discovery ──────────────────────────────────────────────

  private async discoverMemories(): Promise<{
    global: EvidenceItem[];
    personal: Array<{ globalAnchor: string; item: EvidenceItem }>;
  }> {
    if (!existsSync(this.memoryRoot)) return { global: [], personal: [] };
    const global: EvidenceItem[] = [];
    const personal: Array<{ globalAnchor: string; item: EvidenceItem }> = [];

    for (const projEntry of await readdir(this.memoryRoot, { withFileTypes: true })) {
      if (!projEntry.isDirectory()) continue;
      const memDir = join(this.memoryRoot, projEntry.name, 'memory');
      if (!existsSync(memDir)) continue;

      const slug = extractProjectSlug(projEntry.name);

      for (const file of await readdir(memDir)) {
        if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
        const filePath = join(memDir, file);
        const content = await readFile(filePath, 'utf-8');
        const header = readFrontmatter(content);
        const fm = header?.data;
        const stem = file.replace(/\.md$/, '');
        const memType = text(fm?.type) ?? 'reference';
        const kind = MEMORY_KIND_MAP[memType] ?? 'lesson';

        const globalAnchor = `global:memory/${slug}/${stem}`;
        const baseItem: Omit<EvidenceItem, 'anchor'> = {
          kind,
          status: 'active',
          title: text(fm?.name) ?? extractTitle(content) ?? stem,
          summary: text(fm?.description) ?? content.slice(0, 300),
          updatedAt: (await stat(filePath)).mtime.toISOString(),
        };

        if (isPersonalMemorySource(stem, header)) {
          personal.push({
            globalAnchor,
            item: { anchor: `domain:personal-memory/${slug}/${stem}`, ...baseItem },
          });
        } else {
          global.push({ anchor: globalAnchor, ...baseItem });
        }
      }
    }
    return { global, personal };
  }

  // ── Distilled truths discovery (F152 Phase C) ─────────────────────

  private async discoverDistilledTruths(): Promise<EvidenceItem[]> {
    if (!this.distilledRoot || !existsSync(this.distilledRoot)) return [];
    const items: EvidenceItem[] = [];

    for (const file of await readdir(this.distilledRoot)) {
      if (!file.endsWith('.md')) continue;
      const filePath = join(this.distilledRoot, file);
      const content = await readFile(filePath, 'utf-8');
      const frontmatter = readFrontmatter(content);

      // Only include files with type: distilled frontmatter
      if (!frontmatter || text(frontmatter.data.type) !== 'distilled') continue;
      const fm = frontmatter.data;

      const distilledId = text(fm.candidate_id) ?? file.replace(/\.md$/, '');
      const title = extractTitle(content) ?? distilledId;
      const kind = (MEMORY_KIND_MAP[text(fm.kind) ?? ''] ?? text(fm.kind) ?? 'lesson') as EvidenceKind;

      // Extract summary: everything after frontmatter + title
      const afterFm = frontmatter.body.trim();
      const lines = afterFm.split('\n');
      const titleIdx = lines.findIndex((l) => l.startsWith('# '));
      const summary =
        titleIdx >= 0
          ? lines
              .slice(titleIdx + 1)
              .join('\n')
              .trim()
          : afterFm;

      const keywords = keywordList(fm.keywords);

      items.push({
        anchor: `distilled:${distilledId}`,
        kind,
        status: 'active',
        title,
        summary: summary || content.slice(0, 300),
        keywords,
        updatedAt: (await stat(filePath)).mtime.toISOString(),
      });
    }
    return items;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private async indexDir(dirPath: string, kind: EvidenceKind, anchorPrefix: string): Promise<EvidenceItem[]> {
    if (!existsSync(dirPath)) return [];
    const items: EvidenceItem[] = [];

    for (const file of await readdir(dirPath)) {
      if (!file.endsWith('.md')) continue;
      const filePath = join(dirPath, file);
      const content = await readFile(filePath, 'utf-8');
      const fm = readFrontmatter(content)?.data;
      const stem = file.replace(/\.md$/, '');

      items.push({
        anchor: `${anchorPrefix}/${stem}`,
        kind,
        status: 'active',
        title: text(fm?.name) ?? extractTitle(content) ?? stem,
        summary: text(fm?.description) ?? content.slice(0, 300),
        updatedAt: (await stat(filePath)).mtime.toISOString(),
      });
    }
    return items;
  }
}

async function replaceStoreProjection(store: SqliteEvidenceStore, items: EvidenceItem[]): Promise<void> {
  const freshAnchors = new Set(items.map((item) => item.anchor));
  const existing = store.getDb().prepare('SELECT anchor FROM evidence_docs').all() as Array<{ anchor: string }>;
  for (const row of existing) {
    if (!freshAnchors.has(row.anchor)) await store.deleteByAnchor(row.anchor);
  }
  if (items.length > 0) await store.upsert(items);
}

/**
 * Header fields that make a memory personal. A field counts when it declares the marker — as its
 * value, or as an item of a flat list — and also when its value has any other shape (a map, a
 * nested or self-referencing list): an uninterpretable privacy declaration stays personal. The
 * shape is read before any comparison and nothing recurses, so no value can stop the rebuild.
 */
const PERSONAL_MARKERS = [
  ['type', 'user'],
  ['scope', 'personal'],
  ['sensitivity', 'private'],
] as const;
const PERSONAL_MARKER_BY_FIELD = new Map<string, string>(PERSONAL_MARKERS);

function isPersonalMemorySource(stem: string, header: FrontmatterReading | null): boolean {
  return header?.declaresPersonal === true || /^user_/i.test(stem) || stem.toLowerCase() === 's8_hourly_log';
}

/** One privacy field's value against its marker; an empty value declares nothing. */
function declaresPrivacy(value: unknown, marker: string): boolean {
  if (value === null || value === undefined || value === '') return false;
  const items = (Array.isArray(value) ? value : [value]).map(text);
  return items.some((item) => item === undefined || item.toLowerCase() === marker);
}

/**
 * In a header YAML rejects as a whole, a privacy field anywhere in what the parser recovered
 * counts like a parsed one, and an unresolved value (e.g. an alias without its anchor) counts
 * too. A broken header without such a field stays shared.
 */
function declaresPersonalPair({ key, value, resolved }: FrontmatterPair): boolean {
  const marker = PERSONAL_MARKER_BY_FIELD.get(key);
  if (marker === undefined) return false;
  return !resolved || declaresPrivacy(value, marker);
}

// ── Pure utility functions ──────────────────────────────────────────

type Frontmatter = Record<string, unknown>;

interface FrontmatterReading {
  data: Frontmatter;
  body: string;
  declaresPersonal: boolean;
}

/**
 * The header read as standard YAML (LF/CRLF, quotes, lists, comments). When YAML rejects it as a
 * whole — e.g. an unquoted `note: a: b` — the same parser still reads every pair in the whole
 * document's context (readFrontmatterPairs): fields written at the start of a line feed the
 * title and summary, and any privacy field counts (declaresPersonalPair). No header: null.
 */
function readFrontmatter(content: string): FrontmatterReading | null {
  const header = readMarkdownFrontmatter(content);
  if (header.status === 'missing') return null;
  if (header.status === 'parsed') {
    const data = header.data;
    const declaresPersonal = PERSONAL_MARKERS.some(([field, marker]) => declaresPrivacy(data[field], marker));
    return { data, body: header.body, declaresPersonal };
  }
  const pairs = readFrontmatterPairs(header.yaml);
  return { data: lineStartFields(pairs), body: header.body, declaresPersonal: pairs.some(declaresPersonalPair) };
}

/** The first readable value of each field written at the start of a line. */
function lineStartFields(pairs: readonly FrontmatterPair[]): Frontmatter {
  const seen = new Set<string>();
  const fields = pairs.filter((pair) => pair.atLineStart && pair.resolved && !seen.has(pair.key) && seen.add(pair.key));
  return Object.fromEntries(fields.map((pair) => [pair.key, pair.value]));
}

/** A scalar header value as text; lists, maps and empty values are not. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

/** `keywords: [a, b]` as a YAML list; a quoted `"[a, b]"` string is split the same way. */
function keywordList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const keywords = value.map(text).filter((keyword): keyword is string => keyword !== undefined);
    return keywords.length > 0 ? keywords : undefined;
  }
  const listed = typeof value === 'string' ? value.match(/\[(.+)]/)?.[1] : undefined;
  return listed?.split(',').map((s) => s.trim());
}

/** Extract first markdown heading as title */
function extractTitle(content: string): string | null {
  const m = content.match(/^#+\s+(.+)$/m);
  return m?.[1]?.trim() ?? null;
}

/** Extract project slug from encoded dir name like "-Users-you-projects-relay-station-cat-cafe" */
function extractProjectSlug(dirName: string): string {
  // Use full dir name (strip leading dash) — guaranteed unique since it's an encoded full path
  return dirName.replace(/^-+/, '') || dirName;
}
