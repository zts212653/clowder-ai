/** Convention expansion for co-located session hooks. */
import { basename, join, relative } from 'node:path';
import { HookRegistry } from '../prompt-hooks/HookRegistry.js';
import type { ConventionGraphAdapter } from './CoverageSearchService.js';

interface SessionHookNode {
  name: string;
  kind: string;
  filePath?: string;
}

// ── Adapter ─────────────────────────────────────────────────────────

type ConsumerResult = {
  anchor: string;
  title: string;
  kind: string;
  filePath?: string;
  edgeStrength: 'static' | 'heuristic';
  stale: boolean;
};

/**
 * Generate an evidence-compatible anchor for a node.
 * Nodes whose filePath starts with 'docs/' get `doc:<path-without-.md>` format
 * matching GenericRepoScanner's default anchor convention.
 * Other nodes keep their name as anchor (best-effort).
 */
function computeEvidenceAnchor(node: SessionHookNode): string {
  if (node.filePath?.startsWith('docs/')) {
    return `doc:${node.filePath.replace(/\.md$/, '')}`;
  }
  return node.name;
}

/**
 * Build the sibling lookup table. Each node's "consumers" are all other nodes
 * in the same domain (they all feed the same session pipeline).
 *
 * Two invariants maintained here (from review P1-1 / P1-2):
 *   1. Anchors use evidence-compatible format (doc:<path> for docs/)
 *   2. Cross-kind siblings sort first (diverse results surface before budget cap)
 */
function buildSiblingLookup(nodes: SessionHookNode[]): Map<string, ConsumerResult[]> {
  const lookup = new Map<string, ConsumerResult[]>();

  // Build consumer records for all nodes (with evidence-compatible anchors)
  const allConsumers: ConsumerResult[] = nodes.map((n) => ({
    anchor: computeEvidenceAnchor(n),
    title: titleFor(n),
    kind: n.kind,
    filePath: n.filePath,
    edgeStrength: 'static' as const,
    stale: false,
  }));

  // For each node, siblings = all others, sorted cross-kind first.
  // When maxPerType caps at 3, diverse-kind results survive the budget cut.
  for (const node of nodes) {
    const selfAnchor = computeEvidenceAnchor(node);
    const siblings = allConsumers
      .filter((c) => c.anchor !== selfAnchor)
      .sort((a, b) => {
        const aCross = a.kind !== node.kind ? 0 : 1;
        const bCross = b.kind !== node.kind ? 0 : 1;
        return aCross - bCross;
      });
    lookup.set(node.name, siblings);

    // Also index by stripped filename (without .md extension) for fuzzy matching
    const stripped = node.name.replace(/\.md$/, '');
    if (stripped !== node.name && !lookup.has(stripped)) {
      lookup.set(stripped, siblings);
    }

    // Also index by evidence anchor for direct lookup from search results
    if (selfAnchor !== node.name && !lookup.has(selfAnchor)) {
      lookup.set(selfAnchor, siblings);
    }
  }

  return lookup;
}

function titleFor(node: SessionHookNode): string {
  return `${node.name} — session hook`;
}

export class SessionHookConventionGraphAdapter implements ConventionGraphAdapter {
  private readonly siblingLookup: Map<string, ConsumerResult[]>;
  private readonly available: boolean;

  constructor(repoRoot: string) {
    const hooksDir = join(repoRoot, 'assets', 'prompt-hooks');
    const registry = new HookRegistry(hooksDir, join(repoRoot, 'assets', 'prompt-templates'));
    registry.scan();
    const nodes: SessionHookNode[] = registry.getStageHooks('session-init').map(({ templatePath }) => ({
      name: basename(templatePath),
      kind: 'session_hook',
      filePath: relative(repoRoot, templatePath),
    }));
    if (nodes.length > 0) {
      nodes.push({ name: 'cat-dossier', kind: 'session_data_source', filePath: 'docs/team/cat-dossier.md' });
    }
    this.siblingLookup = buildSiblingLookup(nodes);
    this.available = nodes.length > 0;
  }

  /**
   * For testing: create an adapter from pre-parsed data instead of reading from disk.
   */
  static fromNodes(nodes: SessionHookNode[]): SessionHookConventionGraphAdapter {
    const adapter = Object.create(SessionHookConventionGraphAdapter.prototype) as SessionHookConventionGraphAdapter;
    (adapter as unknown as { siblingLookup: Map<string, ConsumerResult[]> }).siblingLookup = buildSiblingLookup(nodes);
    (adapter as unknown as { available: boolean }).available = nodes.length > 0;
    return adapter;
  }

  async queryConsumers(name: string): Promise<ConsumerResult[]> {
    // Try exact match first, then stripped version
    const exact = this.siblingLookup.get(name);
    if (exact) return exact;

    // Try matching against node names that contain the query name
    for (const [key, consumers] of this.siblingLookup) {
      if (key.includes(name) || name.includes(key)) {
        return consumers;
      }
    }

    return [];
  }

  isAvailable(): boolean {
    return this.available;
  }
}
