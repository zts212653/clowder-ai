// F186 Phase B: Level 1 scanner — uses existing frontmatter, WikiLinks, SUMMARY.md

import {
  extractAnchor,
  extractEvidenceStatus,
  extractFeatureIdKeywords,
  extractFrontmatter,
  extractSupersededBy,
} from './CatCafeScanner.js';
import { extractFrontmatterKeywords, resolveFrontmatterEvidenceKind } from './CatCafeScannerParsing.js';
import { FlatScanner } from './FlatScanner.js';
import type { ScannedEvidence } from './interfaces.js';

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

    const fmAnchor = extractAnchor(frontmatter, base.item.sourcePath);
    if (fmAnchor) base.item.anchor = `${this.collectionId}:${fmAnchor}`;

    const resolvedKind = resolveFrontmatterEvidenceKind(frontmatter);
    if (resolvedKind) base.item.kind = resolvedKind;
    base.item.status = extractEvidenceStatus(frontmatter);
    const supersededBy = extractSupersededBy(frontmatter);
    if (supersededBy) base.item.supersededBy = supersededBy;

    const topicStrs = extractFrontmatterKeywords(frontmatter);
    const featureIdKw = extractFeatureIdKeywords(frontmatter, base.item.sourcePath ?? '');
    const sectionKw = base.item.keywords ?? [];
    const seen = new Set(topicStrs.map((t) => t.toLowerCase()));
    for (const fid of featureIdKw) {
      if (!seen.has(fid.toLowerCase())) seen.add(fid.toLowerCase());
    }
    const dedupSection = sectionKw.filter((k) => !seen.has(k.toLowerCase()));
    for (const k of dedupSection) seen.add(k.toLowerCase());
    const dedupWiki = wikiLinks.filter((l) => !seen.has(l.toLowerCase()));
    const merged = [...topicStrs, ...featureIdKw, ...dedupSection, ...dedupWiki];
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
