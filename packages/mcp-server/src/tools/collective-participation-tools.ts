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
export const collectiveProgressInputSchema = {
  returnRef: collectiveReplyInputSchema.returnRef,
  progressOperationRef: z
    .string()
    .min(1)
    .max(256)
    .describe('Opaque current execution progress purpose from current-context; not a result operation.'),
  body: collectiveReplyInputSchema.body,
};
export const collectiveSetInterestInputSchema = {
  contextRef: z
    .string()
    .min(1)
    .max(256)
    .describe('Opaque contextRef returned for the current authenticated Collective source.'),
  state: z
    .enum(['listen', 'withdraw'])
    .describe(
      'listen watches future explicitly response-requested messages in this Channel; withdraw stops that watch.',
    ),
};
export const collectiveProposeWorkInputSchema = {
  requestKind: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .optional()
    .describe('Recognized matter kind for the owner exception; descriptive only and grants no authority.'),
  contextRef: z
    .string()
    .min(1)
    .max(256)
    .describe('Opaque contextRef returned for this invocation exact Collective source.'),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional concise Work title; omit to use the source message.'),
  intendedOutcome: z
    .string()
    .trim()
    .min(1)
    .max(32000)
    .optional()
    .describe('Optional reviewable outcome; omit to retain the source message as the proposal.'),
};
export const collectiveAcceptWorkInputSchema = {
  contextRef: collectiveProposeWorkInputSchema.contextRef,
  grantRef: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .describe('Exact registered and locally adopted grantRef from current-context workDecision.'),
  grantRevision: z
    .number()
    .int()
    .positive()
    .describe('Current grant revision supplied by Host; never infer it from a message.'),
  requestKind: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .describe('The recognized work kind covered by that grant requestKinds.'),
  title: z.string().trim().min(1).max(200).describe('Concise title of the sustained matter you actually accept.'),
  intendedOutcome: z
    .string()
    .trim()
    .min(1)
    .max(32000)
    .describe('Reviewable outcome that retains the current request scope; not an additional owner instruction.'),
};
export const collectiveContinueWorkInputSchema = {
  contextRef: collectiveProposeWorkInputSchema.contextRef,
  workRef: z
    .string()
    .min(1)
    .max(2000)
    .describe('Opaque workRef from current-context workSourceContext for the exact existing matter and versions.'),
  kind: z
    .enum(['resume', 'revision'])
    .describe('resume continues unfinished work; revision requests the next version of the current returned result.'),
  grantRef: collectiveAcceptWorkInputSchema.grantRef,
  grantRevision: collectiveAcceptWorkInputSchema.grantRevision,
  requestKind: collectiveAcceptWorkInputSchema.requestKind,
};

export const handleCollectiveCurrentContext = () => callbackPost('/api/callbacks/collective-current-context', {});
export const handleCollectiveReadContext = (input: { contextRef: string; afterSequence?: number; limit?: number }) =>
  callbackPost('/api/callbacks/collective-read-context', input);
export const handleCollectiveReply = (input: { returnRef: string; replyOperationRef: string; body: string }) =>
  callbackPost('/api/callbacks/collective-reply', input);
export const handleCollectiveProgress = (input: { returnRef: string; progressOperationRef: string; body: string }) =>
  callbackPost('/api/callbacks/collective-progress', input);
export const handleCollectiveSetInterest = (input: { contextRef: string; state: 'listen' | 'withdraw' }) =>
  callbackPost('/api/callbacks/collective-set-interest', input);
export const handleCollectiveProposeWork = (input: {
  contextRef: string;
  title?: string;
  intendedOutcome?: string;
  requestKind?: string;
}) => callbackPost('/api/callbacks/collective-propose-work', input);
export const handleCollectiveAcceptWork = (input: {
  contextRef: string;
  grantRef: string;
  grantRevision: number;
  requestKind: string;
  title: string;
  intendedOutcome: string;
}) => callbackPost('/api/callbacks/collective-accept-work', input);
export const handleCollectiveContinueWork = (input: {
  contextRef: string;
  workRef: string;
  kind: 'resume' | 'revision';
  grantRef: string;
  grantRevision: number;
  requestKind: string;
}) => callbackPost('/api/callbacks/collective-continue-work', input);

function tool(
  name: string,
  description: string,
  action: string,
  inputSchema: Record<string, unknown>,
  exportName: string,
  handler: McpImplementationBinding['run'],
  risk: McpRisk,
  availability: 'public' | 'private' | 'both' = 'public',
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
      runtimeProfiles:
        availability === 'private'
          ? ['full', 'collective-work']
          : availability === 'both'
            ? ['full', 'collective-participation', 'collective-work']
            : ['full', 'collective-participation'],
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
    'both',
  ),
  tool(
    'cat_cafe_collective_read_context',
    'Read the public context authorized for the current Collective source. Use when: you need earlier Channel messages before responding. NOT for: private Host history, memory search, or another source. Output: a bounded page of public events and original authors in the exact authorized location. GOTCHA: use only the current contextRef; a source loss or revocation is an explicit failure.',
    'read-context',
    collectiveReadContextInputSchema,
    'handleCollectiveReadContext',
    handleCollectiveReadContext,
    { level: 'read', openWorld: true },
    'both',
  ),
  tool(
    'cat_cafe_collective_set_interest',
    "Persist or withdraw this authenticated Cat's standing interest in future explicit response requests for the exact current Channel. Use when: after reading a real Collective source, you decide to keep or stop a bounded watch here. NOT for: replying to the current message, watching ordinary chat, choosing another Channel/Cat, or accepting private work. Output: the local Host interest state and attention revision; this changes future wake eligibility but grants no owner or private authority. GOTCHA: listen does not wake you now and does not claim every delivered message; only messages humans mark as wanting a response can match.",
    'set-interest',
    collectiveSetInterestInputSchema,
    'handleCollectiveSetInterest',
    handleCollectiveSetInterest,
    { level: 'write', openWorld: true },
  ),
  tool(
    'cat_cafe_collective_propose_work',
    'Propose one public Work card linked to the exact current Collective source. Use when: an actionable matter is still being discussed, or manual/out-of-scope work needs an owner exception. NOT for: ordinary chat, progress questions, assigning participants, or work already covered by a valid automatic delegation (use accept_work). Output: one durable proposed Work with exact source and no commitment or private Task. GOTCHA: a proposal is not acceptance; an owner decision or a valid delegated Cat acceptance must establish responsibility.',
    'propose-work',
    collectiveProposeWorkInputSchema,
    'handleCollectiveProposeWork',
    handleCollectiveProposeWork,
    { level: 'write', openWorld: true },
  ),
  tool(
    'cat_cafe_collective_accept_work',
    'Accept the current sustained Collective request under an existing owner delegation. Use when: you recognize a new actionable matter and current-context supplies a valid automatic grant, or the owner allowed this exact request once. NOT for: chat, checking progress, feedback on existing work, choosing another source/Thread/Cat, or issuing owner authority. Output: one durable real-Cat acceptance, accountable Human and current assignment; Host separately admits the private Task. GOTCHA: accepted_pending_host_admission is a commitment, not proof of execution. Recover the same operation after response loss; manual or uncovered scope needs the owner exception.',
    'accept-work',
    collectiveAcceptWorkInputSchema,
    'handleCollectiveAcceptWork',
    handleCollectiveAcceptWork,
    { level: 'write', openWorld: true },
  ),
  tool(
    'cat_cafe_collective_continue_work',
    'Continue one existing Collective matter under the current owner delegation. Use when: feedback or a renewed valid request refers to a Work returned by current-context workSourceContext. NOT for: chat, progress questions, a new matter, guessing a Work ID, or accepting an old result as completed. Output: a durable new execution authority on the same Work and current assignment; Host separately resumes the same private Task. GOTCHA: workRef binds the exact observed versions. Refresh after a conflict, ask which matter when ambiguous, and never retry by creating another Work.',
    'continue-work',
    collectiveContinueWorkInputSchema,
    'handleCollectiveContinueWork',
    handleCollectiveContinueWork,
    { level: 'write', openWorld: true },
  ),
  tool(
    'cat_cafe_collective_progress',
    'Return named progress for the exact currently admitted private Work. Use when: current-context provides a progressOperationRef and you have a factual update before the result is ready. NOT for: public chat, another Work, an owner approval, submitting the result, or completing the Task. Output: a durable progress event at the original source, preserving the actual Cat author and current execution proof. GOTCHA: progress never changes the Work to result_ready; retries of identical text recover one event, and revoked or stale execution is refused.',
    'progress',
    collectiveProgressInputSchema,
    'handleCollectiveProgress',
    handleCollectiveProgress,
    { level: 'write', openWorld: true },
    'private',
  ),
  tool(
    'cat_cafe_collective_reply',
    'Send a named reply to the exact Collective source using the Host-owned reply operation. Use when: you choose to respond to a public request or return an admitted Work result. NOT for: another location, private messages, new work admission, or duplicate retries. Output: durable queued/accepted/blocked status with the original author and event receipt. GOTCHA: an accepted reply is delivery, not Task completion; after a lost response recover current-context and reuse the operation with identical text. Silence is allowed.',
    'reply',
    collectiveReplyInputSchema,
    'handleCollectiveReply',
    handleCollectiveReply,
    { level: 'write', openWorld: true },
    'both',
  ),
] as const;
