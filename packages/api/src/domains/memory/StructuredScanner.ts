// F186 Phase B: Level 1 scanner — uses existing frontmatter, WikiLinks, SUMMARY.md

import { extractAnchor, extractFrontmatter } from './CatCafeScanner.js';
import { FlatScanner } from './FlatScanner.js';
import type { EvidenceKind, ScannedEvidence } from './interfaces.js';

const FRONTMATTER_KIND_MAP: Record<string, EvidenceKind> = {
  feature: 'feature',
  spec: 'feature',
  decision: 'decision',
  adr: 'decision',
  plan: 'plan',
  design: 'plan',
  lesson: 'lesson',
  postmortem: 'lesson',
  reflection: 'lesson',
  discussion: 'discussion',
  research: 'research',
};

export class StructuredScanner extends FlatScanner {
  protected override parseFile(filePath: string, root: string): ScannedEvidence | null {
    const base = super.parseFile(filePath, root);
    if (!base) return null;

    const wikiLinks = extractWikiLinks(base.rawContent);
    const frontmatter = extractFrontmatter(base.rawContent);

    if (!frontmatter) {
      if (wikiLinks.length > 0) {
        const existing = base.item.keywords ?? [];
        const seen = new Set(existing.map((k) => k.toLowerCase()));
        base.item.keywords = [...existing, ...wikiLinks.filter((l) => !seen.has(l.toLowerCase()))];
      }
      return base;
    }

    base.provenance = { tier: 'authoritative', source: base.item.sourcePath ?? '' };

    const fmAnchor = extractAnchor(frontmatter);
    if (fmAnchor) base.item.anchor = `${this.collectionId}:${fmAnchor}`;

    const docKind = frontmatter.doc_kind;
    if (typeof docKind === 'string' && FRONTMATTER_KIND_MAP[docKind]) {
      base.item.kind = FRONTMATTER_KIND_MAP[docKind]!;
    }

    const topics = frontmatter.topics;
    const topicStrs = Array.isArray(topics) ? topics.filter((t): t is string => typeof t === 'string') : [];
    const sectionKw = base.item.keywords ?? [];
    const seen = new Set(topicStrs.map((t) => t.toLowerCase()));
    const dedupSection = sectionKw.filter((k) => !seen.has(k.toLowerCase()));
    for (const k of dedupSection) seen.add(k.toLowerCase());
    const dedupWiki = wikiLinks.filter((l) => !seen.has(l.toLowerCase()));
    const merged = [...topicStrs, ...dedupSection, ...dedupWiki];
    if (merged.length > 0) base.item.keywords = merged;

    return base;
  }
}

function extractWikiLinks(content: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const target = match[1]!.trim();
    const lower = target.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      links.push(target);
    }
  }
  return links;
}
