import { dirname, join, normalize } from 'node:path/posix';

export interface ExtractedEdge {
  fromAnchor: string;
  toAnchor: string;
  relation: 'wikilink' | 'doc_link' | 'feature_ref';
  provenance: 'content';
}

export function extractWikiLinkEdges(content: string, selfAnchor: string): ExtractedEdge[] {
  const edges: ExtractedEdge[] = [];
  const seen = new Set<string>();
  const selfLower = selfAnchor.toLowerCase();
  for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const target = match[1]!.trim();
    const lower = target.toLowerCase();
    if (lower === selfLower || seen.has(lower)) continue;
    seen.add(lower);
    edges.push({ fromAnchor: selfAnchor, toAnchor: target, relation: 'wikilink', provenance: 'content' });
  }
  return edges;
}

export function extractFeatureRefEdges(content: string, selfAnchor: string): ExtractedEdge[] {
  let masked = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
  masked = masked.replace(/\[\[[^\]]*\]\]/g, (m) => ' '.repeat(m.length));
  masked = masked.replace(/\[[^\]]*\]\([^)]*\)/g, (m) => ' '.repeat(m.length));
  const edges: ExtractedEdge[] = [];
  const seen = new Set<string>();
  for (const match of masked.matchAll(/\bF(\d{2,4})(?![-a-zA-Z])\b/g)) {
    const num = parseInt(match[1]!, 10);
    if (num > 999) continue;
    const fRef = `F${String(num).padStart(3, '0')}`;
    if (fRef === selfAnchor || seen.has(fRef)) continue;
    seen.add(fRef);
    edges.push({ fromAnchor: selfAnchor, toAnchor: fRef, relation: 'feature_ref', provenance: 'content' });
  }
  return edges;
}

export function extractDocLinkEdges(
  content: string,
  selfAnchor: string,
  pathToAnchor: Map<string, string>,
  sourcePath?: string,
): ExtractedEdge[] {
  const edges: ExtractedEdge[] = [];
  const seen = new Set<string>();
  const sourceDir = sourcePath ? dirname(sourcePath) : undefined;
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const rawLink = match[1]!;
    if (rawLink.startsWith('http') || rawLink.startsWith('#')) continue;
    const linkPath = rawLink.replace(/[#?].*$/, '');
    let targetAnchor: string | undefined;
    if (linkPath.startsWith('/docs/')) {
      const docsPath = linkPath.slice(1);
      targetAnchor = pathToAnchor.get(docsPath) ?? pathToAnchor.get(linkPath.slice(6));
    } else {
      const normalized = linkPath.replace(/^(?:\.\.\/)+/, '').replace(/^\.\//, '');
      const resolved = sourceDir ? normalize(join(sourceDir, linkPath)) : undefined;
      targetAnchor =
        pathToAnchor.get(linkPath) ?? (resolved ? pathToAnchor.get(resolved) : pathToAnchor.get(normalized));
    }
    if (!targetAnchor || targetAnchor === selfAnchor || seen.has(targetAnchor)) continue;
    seen.add(targetAnchor);
    edges.push({ fromAnchor: selfAnchor, toAnchor: targetAnchor, relation: 'doc_link', provenance: 'content' });
  }
  return edges;
}
