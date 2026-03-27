/**
 * F129 PackKnowledgeScope — Pack-scoped Knowledge Isolation (AC-A10)
 *
 * Phase A foundation: registers pack knowledge/ files in evidence_docs
 * with pack_id scope. Global search excludes pack-knowledge by default.
 * Actual RAG retrieval is deferred to Phase B.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { EvidenceItem, IEvidenceStore } from '../memory/interfaces.js';

/** Extended store with pack-specific operations */
interface PackAwareStore extends IEvidenceStore {
  deleteByPackId?(packId: string): Promise<number>;
}

export class PackKnowledgeScope {
  constructor(private readonly evidenceStore: PackAwareStore) {}

  /**
   * Register knowledge files from a pack's knowledge/ directory.
   * Each .md file gets an evidence_docs entry with pack_id = packName.
   */
  async registerKnowledge(packName: string, knowledgeDir: string): Promise<number> {
    let entries: string[];
    try {
      const s = await stat(knowledgeDir);
      if (!s.isDirectory()) return 0;
      entries = await readdir(knowledgeDir);
    } catch {
      return 0; // No knowledge dir — ok
    }

    const items: EvidenceItem[] = [];
    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (ext !== '.md' && ext !== '.txt') continue;

      const filePath = join(knowledgeDir, entry);
      try {
        const content = await readFile(filePath, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
        const title = extractTitle(content, entry);

        items.push({
          anchor: `pack:${packName}:${basename(entry, ext)}`,
          kind: 'pack-knowledge',
          status: 'active',
          title,
          summary: content.slice(0, 500),
          keywords: [packName],
          sourcePath: filePath,
          sourceHash: hash,
          updatedAt: new Date().toISOString(),
          packId: packName,
        });
      } catch {
        // Skip unreadable files
      }
    }

    if (items.length > 0) {
      await this.evidenceStore.upsert(items);
    }
    return items.length;
  }

  /**
   * Remove all knowledge entries for a pack.
   * Uses direct SQL delete by pack_id (no limit, no search dependency).
   */
  async removeKnowledge(packName: string): Promise<void> {
    if (this.evidenceStore.deleteByPackId) {
      await this.evidenceStore.deleteByPackId(packName);
    } else {
      // Fallback: delete by anchor prefix pattern
      await this.evidenceStore.deleteByAnchor(`pack:${packName}:%`);
    }
  }
}

/** Extract title from markdown content or fall back to filename */
function extractTitle(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : basename(filename, extname(filename));
}
