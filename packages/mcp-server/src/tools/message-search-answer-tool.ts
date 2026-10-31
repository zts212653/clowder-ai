import { z } from 'zod';
import { bindMcpImplementation, defineMcpTool } from '../tool-governance.js';
import { callbackPost } from './callback-tools.js';
import { type MessageSearchToolQuery, messageSearchParams } from './message-search-transport.js';

interface PrepareSearchAnswer extends Omit<MessageSearchToolQuery, 'mode'> {
  retrievalMode?: MessageSearchToolQuery['mode'];
  operationId: string;
  destinationThreadId?: string;
  replyTo?: string;
  agentKeyCatId?: string;
}
export async function handlePrepareMessageSearchAnswer(input: PrepareSearchAnswer) {
  return callbackPost(
    '/api/callbacks/search-evidence/answer',
    {
      ...messageSearchParams({ ...input, mode: input.retrievalMode }),
      operationId: input.operationId,
      ...(input.destinationThreadId ? { destinationThreadId: input.destinationThreadId } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId, retryDelaysMs: [], enableOutbox: false },
  );
}
/** Separate declared-write operation preserves search_evidence and readonly mounts as reads. */
export function defineMessageSearchAnswerTool(read: Record<string, unknown>) {
  return defineMcpTool({
    name: 'cat_cafe_prepare_message_search_answer',
    description:
      'Prepare a source-backed find card for an answer by executing the existing message search once and durably saving its bounded result. ' +
      'Use when: answering “当时怎么定的 / how did we decide” with the same decided-table card and original sources as Find. ' +
      'NOT for: ordinary recall (use search_evidence with resultUnit=message), hand-written summaries, new search engines or publishing private results into public replies. ' +
      'Output: a TTL=0 prepared publicationRef plus the same bounded message result; this POST writes a publication record and uses the existing search budget. ' +
      'Reuse the same operationId after a lost response: it reads the existing state and never reruns search/model work. ' +
      'A successful normal R attaches its pending card through the Host. Explicit post_message/agent-key replies must pass searchAnswer={publicationRef} and a stable clientMessageId; agent-key preparation requires destinationThreadId. ' +
      'Cloud returns also provide the exact replyTo of the existing server grant. Prepared is not published: only a real message and Host binding prove publication. ' +
      'GOTCHA: create_rich_block or copied card meta cannot create this binding. Do not reconstruct conclusions or labels; pass the reference only.',
    operation: {
      kind: 'single',
      action: 'prepare-answer',
      inputSchema: {
        query: read.query,
        messageSort: read.messageSort,
        retrievalMode: read.mode,
        threadId: read.threadId,
        limit: read.limit,
        dateFrom: read.dateFrom,
        dateTo: read.dateTo,
        agentKeyCatId: read.agentKeyCatId,
        operationId: z
          .string()
          .min(1)
          .max(200)
          .describe('Stable ID for this accepted answer purpose; reuse it on retry, e.g. decide-sidebar-title.'),
        destinationThreadId: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe(
            'Publication destination, separate from search threadId. Required for agent-key auth; invocation must match its authenticated bound thread.',
          ),
        replyTo: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe('Cloud return only: exact original source message covered by the existing Host return grant.'),
      },
      boundary: {
        risk: { level: 'write', openWorld: false },
        authorizationPaths: [
          {
            principal: 'invocation-cat',
            credentialSource: 'callback-principal',
            scope: { kind: 'owner-private' },
            enforcementRef: 'file:packages/api/src/routes/callback-message-search-answer-routes.ts',
          },
          {
            principal: 'agent-key-cat',
            credentialSource: 'agent-key',
            scope: { kind: 'owner-private' },
            enforcementRef: 'file:packages/api/src/routes/callback-message-search-answer-routes.ts',
          },
        ],
      },
    },
    implementation: bindMcpImplementation(
      'module:./tools/message-search-answer-tool.js#handlePrepareMessageSearchAnswer',
      handlePrepareMessageSearchAnswer,
    ),
    policy: {
      resourceFamily: 'evidence-navigation',
      activeState: 'canonical',
      runtimeProfiles: ['full', 'agent-key'],
      schemaDelivery: {
        policy: 'host-default',
        evidenceRef: 'file:packages/mcp-server/src/tools/message-search-answer-tool.ts',
      },
      owner: { domainCell: 'architecture-cell:memory', surface: 'mcp-surface-governance' },
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'authority-boundary',
        admissionRef: 'file:docs/architecture/f322-message-search-answer-contract.md',
      },
      cognitiveEntryPoints: [{ kind: 'tool-description', ref: 'file:packages/mcp-server/src/tools/evidence-tools.ts' }],
      verification: [{ kind: 'test', ref: 'test:packages/api/test/memory/message-search-answer-entry.test.js' }],
    },
  });
}
