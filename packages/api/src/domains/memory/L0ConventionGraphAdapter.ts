/**
 * F256 Phase C: Lightweight ConventionGraphAdapter for L0 prompt builder domain.
 *
 * This adapter enables convention-edge expansion in TopkExpansionService and
 * CoverageSearchService without adding @cat-cafe/convention-graph as a runtime
 * dependency (which would pull in SQLite).
 *
 * It reads the L0 compiler file, parses it using the same logic as the
 * l0-prompt-builder extractor, and builds a sibling lookup table. All nodes
 * that feed the same L0 compilation target are considered "siblings" — querying
 * any sibling returns all others.
 *
 * Design: hub-and-spoke topology → consumers(hub) = all spokes.
 * When asked queryConsumers("l3-routing-rules"), it returns "cat-dossier" (and
 * vice versa) because both feed the same l0_compilation target.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConventionGraphAdapter } from './CoverageSearchService.js';

// ── L0 Compiler Parsing (aligned with l0-prompt-builder extractor) ──

interface L0Node {
  name: string;
  kind: string;
  filePath?: string;
  templateVar?: string;
}

interface L0ParseResult {
  sections: L0Node[];
  dataSources: L0Node[];
}

/**
 * Parse the L0 compiler source to extract template dependencies.
 * This is a lightweight version of the l0-prompt-builder extractor's parser,
 * focused on what the adapter needs (names, kinds, template vars).
 */
function parseL0CompilerForAdapter(content: string): L0ParseResult | null {
  const sections: L0Node[] = [];
  const dataSources: L0Node[] = [];
  const lines = content.split(/\r?\n/);

  // Extract L0_SECTION_TEMPLATES mapping
  let inSectionBlock = false;
  let foundSections = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (/^\s*(?:const|let|var)\s+L0_SECTION_TEMPLATES\s*=\s*\{/.test(line)) {
      inSectionBlock = true;
      foundSections = true;
      continue;
    }

    if (inSectionBlock) {
      if (/^\s*\}/.test(line)) {
        inSectionBlock = false;
        continue;
      }
      const match = line.match(/^\s*(\w+):\s*['"]([^'"]+)['"]/);
      if (match) {
        sections.push({
          name: match[2]!,
          kind: 'l0_section',
          templateVar: match[1]!,
        });
      }
    }
  }

  // The shared dossier module is the stable carrier. Individual helpers may
  // narrow as L0 projections evolve (for example RosterSummary → RoutingNote).
  if (/\bfrom\s+['"]@cat-cafe\/shared\/dossier['"]/.test(content)) {
    dataSources.push({
      name: 'cat-dossier',
      kind: 'l0_data_source',
      filePath: 'docs/team/cat-dossier.md',
      templateVar: 'TEAMMATE_ROSTER',
    });
  }

  if (!foundSections) return null;
  return { sections, dataSources };
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
function computeEvidenceAnchor(node: L0Node): string {
  if (node.filePath?.startsWith('docs/')) {
    return `doc:${node.filePath.replace(/\.md$/, '')}`;
  }
  return node.name;
}

/**
 * Build the sibling lookup table. Each node's "consumers" are all other nodes
 * in the same domain (they all feed the same L0 compilation target).
 *
 * Two invariants maintained here (from review P1-1 / P1-2):
 *   1. Anchors use evidence-compatible format (doc:<path> for docs/)
 *   2. Cross-kind siblings sort first (diverse results surface before budget cap)
 */
function buildSiblingLookup(nodes: L0Node[]): Map<string, ConsumerResult[]> {
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

function titleFor(node: L0Node): string {
  if (node.kind === 'l0_data_source') {
    return `${node.name} — L0 data source (feeds {{${node.templateVar}}})`;
  }
  return `${node.name} — L0 section ({{${node.templateVar}}})`;
}

export class L0ConventionGraphAdapter implements ConventionGraphAdapter {
  private readonly siblingLookup: Map<string, ConsumerResult[]>;
  private readonly available: boolean;

  constructor(repoRoot: string) {
    const compilerPath = resolve(repoRoot, 'scripts/compile-system-prompt-l0.mjs');
    if (!existsSync(compilerPath)) {
      this.siblingLookup = new Map();
      this.available = false;
      return;
    }

    const content = readFileSync(compilerPath, 'utf8');
    const parsed = parseL0CompilerForAdapter(content);
    if (!parsed) {
      this.siblingLookup = new Map();
      this.available = false;
      return;
    }

    const allNodes = [...parsed.sections, ...parsed.dataSources];
    this.siblingLookup = buildSiblingLookup(allNodes);
    this.available = allNodes.length > 0;
  }

  /**
   * For testing: create an adapter from pre-parsed data instead of reading from disk.
   */
  static fromNodes(nodes: L0Node[]): L0ConventionGraphAdapter {
    const adapter = Object.create(L0ConventionGraphAdapter.prototype) as L0ConventionGraphAdapter;
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
