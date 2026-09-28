import { z } from 'zod';
import { bindMcpImplementation, defineMcpTool } from '../tool-governance.js';
import type { McpImplementationBinding, McpRisk } from '../tool-governance-types.js';
import { callbackPost } from './callback-tools.js';

export const collectiveCurrentContextInputSchema = {};
export const collectiveReadContextInputSchema = {
  contextRef: z.string().min(1).max(256).describe('Opaque contextRef returned by current-context in this invocation.'),
  afterSequence: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Read events after this public event sequence; defaults to 0.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum events to read; defaults to 30, at most 100.'),
};
export const collectiveReplyInputSchema = {
  returnRef: z
    .string()
    .min(1)
    .max(256)
    .describe('Opaque returnRef issued by current-context for the exact current source.'),
  replyOperationRef: z
    .string()
    .min(1)
    .max(256)
    .describe('Opaque replyOperationRef issued by current-context for this invocation.'),
  body: z
    .string()
    .trim()
    .min(1)
    .max(20000)
    .describe('Public reply text, up to 20000 characters. A submitted operation must retain its original text.'),
};

export const handleCollectiveCurrentContext = () => callbackPost('/api/callbacks/collective-current-context', {});
export const handleCollectiveReadContext = (input: { contextRef: string; afterSequence?: number; limit?: number }) =>
  callbackPost('/api/callbacks/collective-read-context', input);
export const handleCollectiveReply = (input: { returnRef: string; replyOperationRef: string; body: string }) =>
  callbackPost('/api/callbacks/collective-reply', input);

function tool(
  name: string,
  description: string,
  action: string,
  inputSchema: Record<string, unknown>,
  exportName: string,
  handler: McpImplementationBinding['run'],
  risk: McpRisk,
) {
  const sourceRef = 'file:packages/mcp-server/src/tools/collective-participation-tools.ts' as const;
  return defineMcpTool({
    name,
    description,
    operation: {
      kind: 'single',
      action,
      inputSchema,
      boundary: {
        risk,
        authorizationPaths: [
          {
            principal: 'invocation-cat',
            credentialSource: 'invocation-record',
            scope: { kind: 'assigned-subject', subjectRef: 'invocation-current-collective-source' },
            enforcementRef: 'file:packages/api/src/domains/plugin/builtin-runtime/collective-current-context.ts',
          },
        ],
      },
    },
    implementation: bindMcpImplementation(`module:./tools/collective-participation-tools.js#${exportName}`, handler),
    policy: {
      resourceFamily: 'collective-participation',
      runtimeProfiles: ['full', 'collective-participation'],
      schemaDelivery: { policy: 'host-default', evidenceRef: sourceRef },
      owner: { domainCell: 'architecture-cell:collective-runtime', surface: 'mcp-surface-governance' },
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/features/F290-ai-native-collective.md',
      },
      activeState: 'canonical',
      cognitiveEntryPoints: [{ kind: 'tool-description', ref: sourceRef }],
      verification: [{ kind: 'test', ref: 'test:packages/mcp-server/test/collective-participation-profile.test.ts' }],
    },
  });
}

export const collectiveParticipationTools = [
  tool(
    'cat_cafe_collective_current_context',
    'Resolve the current Collective request and its reply receipt from the authenticated invocation. Use when: a Channel requests your participation or an admitted Work needs to return its result. NOT for: choosing a Channel, connection, private Thread, or granting owner authority. Output: authorized location/actor, opaque context and reply refs, and a durable reply operation allocated or recovered by Host. GOTCHA: this may resume an already requested reply with its original payload; after restart call this again and never copy refs from an earlier invocation.',
    'current-context',
    collectiveCurrentContextInputSchema,
    'handleCollectiveCurrentContext',
    handleCollectiveCurrentContext,
    { level: 'write', openWorld: true },
  ),
  tool(
    'cat_cafe_collective_read_context',
    'Read the public context authorized for the current Collective source. Use when: you need earlier Channel messages before responding. NOT for: private Host history, memory search, or another source. Output: a bounded page of public events and original authors in the exact authorized location. GOTCHA: use only the current contextRef; a source loss or revocation is an explicit failure.',
    'read-context',
    collectiveReadContextInputSchema,
    'handleCollectiveReadContext',
    handleCollectiveReadContext,
    { level: 'read', openWorld: true },
  ),
  tool(
    'cat_cafe_collective_reply',
    'Send a named reply to the exact Collective source using the Host-owned reply operation. Use when: you choose to respond to a public request or return an admitted Work result. NOT for: another location, private messages, new work admission, or duplicate retries. Output: durable queued/accepted/blocked status with the original author and event receipt. GOTCHA: an accepted reply is delivery, not Task completion; after a lost response recover current-context and reuse the operation with identical text. Silence is allowed.',
    'reply',
    collectiveReplyInputSchema,
    'handleCollectiveReply',
    handleCollectiveReply,
    { level: 'write', openWorld: true },
  ),
] as const;
