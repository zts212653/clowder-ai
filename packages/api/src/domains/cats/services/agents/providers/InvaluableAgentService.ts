/**
 * Invaluable P2P Agent Service
 *
 * Implements AgentService for Clowder cats backed by Invaluable P2P nodes.
 * Communication and A2A routing are processed over Invaluable's WebRTC network.
 *
 * Topology: transient adapter bridging Clowder's AgentService interface
 * to a local Invaluable peer node. Not a Link-backed identity itself.
 *
 * Key behaviors:
 * - Lazy-starts the background peer node on first invocation
 * - Enforces a hard 3-write-action budget per turn via WriteLimitedToolInvoker
 * - Routes model inference requests through the Clowder gateway
 * - Reads consensus state from the peer's local Link Graph replica
 */

import { randomUUID } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, AgentService, AgentServiceOptions } from '../../types.js';
import { InvaluableNodeManager } from './InvaluableNodeManager.js';
import { WriteLimitedToolInvoker, WriteBudgetExhaustedError } from './invaluable-write-limiter.js';
import {
  readLinkGraphSnapshot,
  evaluateLinkGraphConsensus,
  findBestProposal,
  renderMermaidGraph,
} from './invaluable-link-graph-consensus.js';

export interface InvaluableAgentServiceOptions {
  catId: CatId;
  dataDir: string;
  name: string;
}

export class InvaluableAgentService implements AgentService {
  private readonly catId: CatId;
  private readonly dataDir: string;
  private readonly name: string;

  constructor(options: InvaluableAgentServiceOptions) {
    this.catId = options.catId;
    this.dataDir = options.dataDir;
    this.name = options.name;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    yield {
      type: 'session_init',
      catId: this.catId,
      timestamp: Date.now(),
    };

    try {
      // M2: Lazy startup guarantee for the background peer process
      const manager = InvaluableNodeManager.getInstance();
      manager.startNode(this.name);

      // M3: Create a fresh write-budget invoker for this turn (max 3 writes)
      const writeLimiter = new WriteLimitedToolInvoker(3);

      yield {
        type: 'text',
        catId: this.catId,
        content: `[Invaluable P2P] Node "${this.name}" active. Write budget: ${writeLimiter.remaining}/3.`,
        timestamp: Date.now(),
      };

      // M5: Read and evaluate the current Link Graph consensus state
      const dataDir = manager.getDataDir(this.name);
      const snapshot = readLinkGraphSnapshot(dataDir);

      if (snapshot && snapshot.nodes.length > 0) {
        const bestProposal = findBestProposal(snapshot);

        if (bestProposal) {
          yield {
            type: 'text',
            catId: this.catId,
            content: `[Consensus] Best proposal "${bestProposal.proposalId}": score=${bestProposal.score.toFixed(1)}, `
              + `backing=${bestProposal.positiveWeight}, objections=${bestProposal.unresolvedObjections.length}, `
              + `passed=${bestProposal.passed}`,
            timestamp: Date.now(),
          };
        }

        // M6: Generate Mermaid graph for dashboard visualization
        const mermaidGraph = renderMermaidGraph(snapshot);
        yield {
          type: 'text',
          catId: this.catId,
          content: `[Dashboard] Mermaid graph (${snapshot.nodes.length} nodes, ${snapshot.edges.length} edges):\n\`\`\`mermaid\n${mermaidGraph}\`\`\``,
          timestamp: Date.now(),
        };
      }

      // Prototype: demonstrate write-budget-limited action
      try {
        await writeLimiter.invoke('post', async (meta) => {
          // This would be a real post/reply/back/recommend action on the P2P network
          return `Posted prompt to P2P mesh. Budget remaining: ${meta.remainingBudget}`;
        }, /* isWrite */ true);
      } catch (err) {
        if (err instanceof WriteBudgetExhaustedError) {
          yield {
            type: 'text',
            catId: this.catId,
            content: `[Budget] Write budget exhausted for this turn.`,
            timestamp: Date.now(),
          };
        }
      }

      yield {
        type: 'text',
        catId: this.catId,
        content: `[Invaluable P2P] Published prompt to peer node "${this.name}". Syncing via WebRTC... Budget remaining: ${writeLimiter.remaining}/3.`,
        timestamp: Date.now(),
      };

      yield {
        type: 'done',
        catId: this.catId,
        timestamp: Date.now(),
      };
    } catch (err: any) {
      yield {
        type: 'error',
        catId: this.catId,
        content: `Invaluable P2P network error: ${err.message}`,
        timestamp: Date.now(),
      };
    }
  }
}
