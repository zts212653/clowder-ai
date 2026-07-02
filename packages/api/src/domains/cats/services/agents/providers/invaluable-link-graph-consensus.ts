/**
 * Invaluable Link Graph Consensus Reader
 *
 * Reads the local P2P node's replicated Link Graph data from `.loop/<name>/`
 * to evaluate consensus on proposals. This is the production replacement for
 * the session-brief-based evaluation, reading directly from the topology.
 *
 * Consensus formula: Score = 100 × T+ / (T+ + T-)
 * where T+ is total positive backing weight and T- is total negative/objection weight.
 * A proposal passes when: Score >= minScore AND unresolvedObjections == 0.
 *
 * Topology: reads from `.loop/<node>/graph/` as local observation state.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';

const log = createModuleLogger('invaluable-link-graph-consensus');

export interface LinkGraphNode {
  id: string;
  type: string; // 'TASK' | 'PROPOSAL' | 'IMPLEMENTATION_CONTRACT' | 'WORK_PACKAGE' | 'COMMENT' | 'BACKING' | 'OBJECTION'
  content: string;
  author: string;
  timestamp: number;
  parentId?: string;
  quantity?: number;
  resolved?: boolean;
}

export interface LinkGraphSnapshot {
  nodes: LinkGraphNode[];
  edges: Array<{ source: string; target: string; relation: string }>;
}

export interface ConsensusResult {
  passed: boolean;
  score: number;
  positiveWeight: number;
  negativeWeight: number;
  unresolvedObjections: LinkGraphNode[];
  proposalId: string;
  error?: string;
}

/**
 * Reads the latest Link Graph snapshot from a peer node's data directory.
 * Falls back to the session-brief format if no graph/ directory exists.
 */
export function readLinkGraphSnapshot(nodeDataDir: string): LinkGraphSnapshot | null {
  const graphDir = join(nodeDataDir, 'graph');

  // Primary path: read from graph/ directory containing replicated Link data
  if (existsSync(graphDir)) {
    return readFromGraphDirectory(graphDir);
  }

  // Fallback: read from a single snapshot JSON file
  const snapshotPath = join(nodeDataDir, 'graph-snapshot.json');
  if (existsSync(snapshotPath)) {
    try {
      const content = readFileSync(snapshotPath, 'utf8');
      return JSON.parse(content) as LinkGraphSnapshot;
    } catch (err) {
      log.warn(`Failed to read graph snapshot at ${snapshotPath}: ${(err as Error).message}`);
      return null;
    }
  }

  return null;
}

function readFromGraphDirectory(graphDir: string): LinkGraphSnapshot {
  const nodes: LinkGraphNode[] = [];
  const edges: Array<{ source: string; target: string; relation: string }> = [];

  let files: string[];
  try {
    files = readdirSync(graphDir).filter(f => f.endsWith('.json'));
  } catch {
    return { nodes, edges };
  }

  for (const file of files) {
    try {
      const content = readFileSync(join(graphDir, file), 'utf8');
      const entry = JSON.parse(content);

      if (entry.node) {
        nodes.push(entry.node);
      }
      if (entry.edges && Array.isArray(entry.edges)) {
        edges.push(...entry.edges);
      }
    } catch {
      // Skip malformed entries
    }
  }

  return { nodes, edges };
}

/**
 * Evaluates consensus on a specific proposal within the Link Graph.
 *
 * Walks the cause→content structure to find all backing and objection
 * commitments under a proposal node, then computes the consensus score.
 */
export function evaluateLinkGraphConsensus(
  snapshot: LinkGraphSnapshot,
  proposalId: string,
  minScore = 80,
): ConsensusResult {
  const proposal = snapshot.nodes.find(n => n.id === proposalId && n.type === 'PROPOSAL');
  if (!proposal) {
    return {
      passed: false,
      score: 0,
      positiveWeight: 0,
      negativeWeight: 0,
      unresolvedObjections: [],
      proposalId,
      error: `Proposal "${proposalId}" not found in graph`,
    };
  }

  // Collect all child commitment nodes under this proposal
  const childNodeIds = new Set<string>();
  collectDescendants(snapshot, proposalId, childNodeIds);

  let positiveWeight = 0;
  let negativeWeight = 0;
  const unresolvedObjections: LinkGraphNode[] = [];

  for (const nodeId of childNodeIds) {
    const node = snapshot.nodes.find(n => n.id === nodeId);
    if (!node) continue;

    const qty = Math.abs(node.quantity ?? 1);

    if (node.type === 'BACKING') {
      positiveWeight += qty;
    } else if (node.type === 'OBJECTION') {
      if (!node.resolved) {
        negativeWeight += qty;
        unresolvedObjections.push(node);
      }
      // Resolved objections don't count against consensus
    }
  }

  const totalWeight = positiveWeight + negativeWeight;
  const score = totalWeight > 0 ? (positiveWeight / totalWeight) * 100 : 0;
  const passed = score >= minScore && unresolvedObjections.length === 0;

  return {
    passed,
    score,
    positiveWeight,
    negativeWeight,
    unresolvedObjections,
    proposalId,
  };
}

/**
 * Recursively collects all descendant node IDs from the graph edges.
 */
function collectDescendants(
  snapshot: LinkGraphSnapshot,
  parentId: string,
  collected: Set<string>,
  visited: Set<string> = new Set(),
): void {
  if (visited.has(parentId)) return; // cycle guard
  visited.add(parentId);

  for (const edge of snapshot.edges) {
    if (edge.source === parentId) {
      collected.add(edge.target);
      collectDescendants(snapshot, edge.target, collected, visited);
    }
  }
}

/**
 * Finds the best (most recent, highest-scored) proposal in the graph.
 */
export function findBestProposal(snapshot: LinkGraphSnapshot, minScore = 80): ConsensusResult | null {
  const proposals = snapshot.nodes.filter(n => n.type === 'PROPOSAL');
  if (proposals.length === 0) return null;

  let best: ConsensusResult | null = null;

  for (const proposal of proposals) {
    const result = evaluateLinkGraphConsensus(snapshot, proposal.id, minScore);
    if (!best || result.score > best.score) {
      best = result;
    }
  }

  return best;
}

/**
 * Generates a Mermaid graph string from a Link Graph snapshot.
 * Used by the front-end dashboard to visualize brainstorm topology.
 */
export function renderMermaidGraph(snapshot: LinkGraphSnapshot): string {
  let mermaid = 'graph TD\n';

  for (const node of snapshot.nodes) {
    const safeLabel = (node.content || node.type).substring(0, 60).replace(/"/g, '\\"');
    const typeTag = node.type;
    const scoreInfo = node.quantity != null ? ` (qty: ${node.quantity})` : '';
    mermaid += `  ${node.id}["${typeTag}: ${safeLabel}${scoreInfo}"]\n`;
  }

  for (const edge of snapshot.edges) {
    const label = edge.relation || '';
    if (label) {
      mermaid += `  ${edge.source} -->|${label}| ${edge.target}\n`;
    } else {
      mermaid += `  ${edge.source} --> ${edge.target}\n`;
    }
  }

  // Style nodes by type
  for (const node of snapshot.nodes) {
    switch (node.type) {
      case 'TASK':
        mermaid += `  style ${node.id} fill:#4a90d9,stroke:#2a6cb7,color:#fff\n`;
        break;
      case 'PROPOSAL':
        mermaid += `  style ${node.id} fill:#50c878,stroke:#3aa362,color:#fff\n`;
        break;
      case 'OBJECTION':
        mermaid += `  style ${node.id} fill:#e74c3c,stroke:#c0392b,color:#fff\n`;
        break;
      case 'BACKING':
        mermaid += `  style ${node.id} fill:#f39c12,stroke:#d68910,color:#fff\n`;
        break;
      default:
        break;
    }
  }

  return mermaid;
}
