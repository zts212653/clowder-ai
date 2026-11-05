import { isAbsolute, relative } from 'node:path';
import { extractFeatureIdKeywords, extractFrontmatter, extractSupersedes } from './CatCafeScannerParsing.js';
import { extractDocLinkEdges, extractFeatureRefEdges, extractWikiLinkEdges } from './edge-extractors.js';
import type { Edge, EvidenceItem } from './interfaces.js';

type DocumentSource = Pick<EvidenceItem, 'anchor' | 'sourcePath'>;

/** Only these projections belong to document indexing; manual/promoted and inbound edges have other owners. */
export const DOCUMENT_SOURCE_EDGE_PREDICATE =
  "((provenance = 'frontmatter' AND relation IN ('related', 'related_to', 'supersedes')) OR provenance = 'content')";

function sourcePathKey(sourcePath: string, scanRoot: string): string {
  return (isAbsolute(sourcePath) ? relative(scanRoot, sourcePath) : sourcePath).replace(/\\/g, '/');
}

export function documentPathToAnchor(sources: readonly DocumentSource[], scanRoot: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const { anchor, sourcePath } of sources) {
    if (!sourcePath) continue;
    const key = sourcePathKey(sourcePath, scanRoot);
    result.set(key, anchor);
    const alias = key.startsWith('docs/') ? key.slice('docs/'.length) : `docs/${key}`;
    if (!result.has(alias)) result.set(alias, anchor);
  }
  return result;
}

/** Shared extraction contract for full rebuild and a single source's incremental replacement. */
export function extractDocumentSourceEdges(
  source: DocumentSource,
  rawContent: string,
  pathToAnchor: Map<string, string>,
  scanRoot: string,
): Edge[] {
  const { anchor } = source;
  const body = rawContent.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const path = source.sourcePath ? sourcePathKey(source.sourcePath, scanRoot) : undefined;
  const edges: Edge[] = [
    ...extractWikiLinkEdges(body, anchor),
    ...extractFeatureRefEdges(body, anchor),
    ...extractDocLinkEdges(body, anchor, pathToAnchor, path),
  ];
  const fm = extractFrontmatter(rawContent);
  if (!fm) return edges;
  for (const ref of extractSupersedes(fm)) {
    if (ref !== anchor)
      edges.push({ fromAnchor: anchor, toAnchor: ref, relation: 'supersedes', provenance: 'frontmatter' });
  }
  const featureRefs = extractFeatureIdKeywords(fm, source.sourcePath ?? '');
  const related = Array.isArray(fm.related_features) ? fm.related_features : [];
  for (const ref of [...related, ...featureRefs]) {
    if (typeof ref === 'string' && ref !== anchor) {
      edges.push({ fromAnchor: anchor, toAnchor: ref, relation: 'related_to', provenance: 'frontmatter' });
    }
  }
  return edges;
}
