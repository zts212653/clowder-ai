/**
 * F102 Phase F-4: GlobalIndexBuilder
 * Compiles global knowledge sources (Skills + MEMORY.md entries) into
 * a read-only SqliteEvidenceStore for federated search via KnowledgeResolver.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
}

export class GlobalIndexBuilder {
  private readonly skillsRoot: string;
  private readonly memoryRoot: string;
  private readonly store: SqliteEvidenceStore;

  constructor(config: GlobalIndexConfig) {
    this.skillsRoot = config.skillsRoot;
    this.memoryRoot = config.memoryRoot;
    this.store = config.globalStore;
  }

  async rebuild(): Promise<RebuildResult> {
    const start = Date.now();
    const items = [...this.discoverSkills(), ...this.discoverMemories()];

    // Clean stale anchors: remove any that are no longer discovered
    const freshAnchors = new Set(items.map((i) => i.anchor));
    const db = this.store.getDb();
    if (db) {
      const existing = db.prepare('SELECT anchor FROM evidence_docs').all() as Array<{ anchor: string }>;
      for (const row of existing) {
        if (!freshAnchors.has(row.anchor)) {
          await this.store.deleteByAnchor(row.anchor);
        }
      }
    }

    if (items.length > 0) await this.store.upsert(items);
    return { docsIndexed: items.length, docsSkipped: 0, durationMs: Date.now() - start };
  }

  // ── Skills discovery ──────────────────────────────────────────────

  private discoverSkills(): EvidenceItem[] {
    if (!existsSync(this.skillsRoot)) return [];
    const items: EvidenceItem[] = [];
    const now = new Date().toISOString();

    for (const entry of readdirSync(this.skillsRoot, { withFileTypes: true })) {
      if (entry.name === 'refs') {
        items.push(...this.indexDir(join(this.skillsRoot, 'refs'), 'decision', 'global:ref', now));
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
        updatedAt: now,
      });
    }
    return items;
  }

  // ── Memory discovery ──────────────────────────────────────────────

  private discoverMemories(): EvidenceItem[] {
    if (!existsSync(this.memoryRoot)) return [];
    const items: EvidenceItem[] = [];
    const now = new Date().toISOString();

    for (const projEntry of readdirSync(this.memoryRoot, { withFileTypes: true })) {
      if (!projEntry.isDirectory()) continue;
      const memDir = join(this.memoryRoot, projEntry.name, 'memory');
      if (!existsSync(memDir)) continue;

      // Extract project slug from dir name (last segment after last dash)
      const slug = extractProjectSlug(projEntry.name);

      for (const file of readdirSync(memDir)) {
        if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
        const content = readFileSync(join(memDir, file), 'utf-8');
        const fm = parseFrontmatter(content);
        const stem = file.replace(/\.md$/, '');
        const memType = fm?.type ?? 'reference';
        const kind = MEMORY_KIND_MAP[memType] ?? 'lesson';

        items.push({
          anchor: `global:memory/${slug}/${stem}`,
          kind,
          status: 'active',
          title: fm?.name ?? extractTitle(content) ?? stem,
          summary: fm?.description ?? content.slice(0, 300),
          updatedAt: now,
        });
      }
    }
    return items;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private indexDir(dirPath: string, kind: EvidenceKind, anchorPrefix: string, now: string): EvidenceItem[] {
    if (!existsSync(dirPath)) return [];
    const items: EvidenceItem[] = [];

    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.md')) continue;
      const content = readFileSync(join(dirPath, file), 'utf-8');
      const fm = parseFrontmatter(content);
      const stem = file.replace(/\.md$/, '');

      items.push({
        anchor: `${anchorPrefix}/${stem}`,
        kind,
        status: 'active',
        title: fm?.name ?? extractTitle(content) ?? stem,
        summary: fm?.description ?? content.slice(0, 300),
        updatedAt: now,
      });
    }
    return items;
  }
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
