/**
 * F102 Phase F-4: GlobalIndexBuilder
 * Compiles global knowledge sources (Skills + MEMORY.md entries) into
 * a read-only SqliteEvidenceStore for federated search via KnowledgeResolver.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

  async rebuild(): Promise<GlobalRebuildResult> {
    const start = Date.now();
    const memories = this.discoverMemories();
    const distilled = this.discoverDistilledTruths();
    const items = [...this.discoverSkills(), ...memories.global, ...distilled];

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

  private discoverSkills(): EvidenceItem[] {
    if (!existsSync(this.skillsRoot)) return [];
    const items: EvidenceItem[] = [];

    for (const entry of readdirSync(this.skillsRoot, { withFileTypes: true })) {
      if (entry.name === 'refs') {
        items.push(...this.indexDir(join(this.skillsRoot, 'refs'), 'decision', 'global:ref'));
        continue;
      }
      if (!entry.isDirectory()) continue;

      const skillPath = join(this.skillsRoot, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;

      const content = readFileSync(skillPath, 'utf-8');
      const fm = parseFrontmatter(content);
      items.push({
        anchor: `global:skill/${entry.name}`,
        kind: 'plan',
        status: 'active',
        title: fm?.name ?? entry.name,
        summary: fm?.description ?? content.slice(0, 300),
        updatedAt: statSync(skillPath).mtime.toISOString(),
      });
    }
    return items;
  }

  // ── Memory discovery ──────────────────────────────────────────────

  private discoverMemories(): {
    global: EvidenceItem[];
    personal: Array<{ globalAnchor: string; item: EvidenceItem }>;
  } {
    if (!existsSync(this.memoryRoot)) return { global: [], personal: [] };
    const global: EvidenceItem[] = [];
    const personal: Array<{ globalAnchor: string; item: EvidenceItem }> = [];

    for (const projEntry of readdirSync(this.memoryRoot, { withFileTypes: true })) {
      if (!projEntry.isDirectory()) continue;
      const memDir = join(this.memoryRoot, projEntry.name, 'memory');
      if (!existsSync(memDir)) continue;

      const slug = extractProjectSlug(projEntry.name);

      for (const file of readdirSync(memDir)) {
        if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
        const filePath = join(memDir, file);
        const content = readFileSync(filePath, 'utf-8');
        const fm = parseFrontmatter(content);
        const stem = file.replace(/\.md$/, '');
        const memType = fm?.type ?? 'reference';
        const kind = MEMORY_KIND_MAP[memType] ?? 'lesson';

        const globalAnchor = `global:memory/${slug}/${stem}`;
        const baseItem: Omit<EvidenceItem, 'anchor'> = {
          kind,
          status: 'active',
          title: fm?.name ?? extractTitle(content) ?? stem,
          summary: fm?.description ?? content.slice(0, 300),
          updatedAt: statSync(filePath).mtime.toISOString(),
        };

        if (isPersonalMemorySource(stem, fm)) {
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

  private discoverDistilledTruths(): EvidenceItem[] {
    if (!this.distilledRoot || !existsSync(this.distilledRoot)) return [];
    const items: EvidenceItem[] = [];

    for (const file of readdirSync(this.distilledRoot)) {
      if (!file.endsWith('.md')) continue;
      const filePath = join(this.distilledRoot, file);
      const content = readFileSync(filePath, 'utf-8');
      const fm = parseFrontmatter(content);

      // Only include files with type: distilled frontmatter
      if (fm?.type !== 'distilled') continue;

      const distilledId = fm.candidate_id ?? file.replace(/\.md$/, '');
      const title = extractTitle(content) ?? distilledId;
      const kind = (MEMORY_KIND_MAP[fm.kind ?? ''] ?? fm.kind ?? 'lesson') as EvidenceKind;

      // Extract summary: everything after frontmatter + title
      const bodyStart = content.indexOf('---', 4);
      let summary = '';
      if (bodyStart >= 0) {
        const afterFm = content.slice(content.indexOf('\n', bodyStart) + 1).trim();
        const lines = afterFm.split('\n');
        const titleIdx = lines.findIndex((l) => l.startsWith('# '));
        summary =
          titleIdx >= 0
            ? lines
                .slice(titleIdx + 1)
                .join('\n')
                .trim()
            : afterFm;
      }

      // Parse keywords from frontmatter
      let keywords: string[] | undefined;
      if (fm.keywords) {
        const kwMatch = fm.keywords.match(/\[(.+)]/);
        if (kwMatch) keywords = kwMatch[1].split(',').map((s) => s.trim());
      }

      items.push({
        anchor: `distilled:${distilledId}`,
        kind,
        status: 'active',
        title,
        summary: summary || content.slice(0, 300),
        keywords,
        updatedAt: statSync(filePath).mtime.toISOString(),
      });
    }
    return items;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private indexDir(dirPath: string, kind: EvidenceKind, anchorPrefix: string): EvidenceItem[] {
    if (!existsSync(dirPath)) return [];
    const items: EvidenceItem[] = [];

    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.md')) continue;
      const filePath = join(dirPath, file);
      const content = readFileSync(filePath, 'utf-8');
      const fm = parseFrontmatter(content);
      const stem = file.replace(/\.md$/, '');

      items.push({
        anchor: `${anchorPrefix}/${stem}`,
        kind,
        status: 'active',
        title: fm?.name ?? extractTitle(content) ?? stem,
        summary: fm?.description ?? content.slice(0, 300),
        updatedAt: statSync(filePath).mtime.toISOString(),
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

function isPersonalMemorySource(stem: string, frontmatter: Record<string, string> | null): boolean {
  return (
    frontmatter?.type?.toLowerCase() === 'user' ||
    frontmatter?.scope?.toLowerCase() === 'personal' ||
    frontmatter?.sensitivity?.toLowerCase() === 'private' ||
    /^user_/i.test(stem) ||
    stem.toLowerCase() === 's8_hourly_log'
  );
}

// ── Pure utility functions ──────────────────────────────────────────

/** Simple YAML frontmatter parser for key: value pairs */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return null;

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    // Match key: value (including multi-word description after >)
    const kv = line.match(/^(\w[\w_]*):\s*(.+)$/);
    if (kv) result[kv[1]!] = kv[2]!.trim();
  }
  return Object.keys(result).length > 0 ? result : null;
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
