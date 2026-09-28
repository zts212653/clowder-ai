import { z } from 'zod';

const postDescription =
  'Post a message to an owner-authorized thread as a persistent agent. ' +
  'Use for a proactive root collaboration or to return your complete final answer to a dispatched request. ' +
  'Agent-key-only registration requires threadId; agentKeyCatId selects your authenticated identity, not the recipient. ' +
  'For a root message, omit replyTo and select intended recipients with targetCats after get_thread_cats. ' +
  'For a gpt-pro return, copy replyTo=sourceMessageId and threadId from the runtime delta; authorization stays in the server grant. ' +
  'Output: a durable message and routing results. Only status ok/duplicate confirms success; queued/routed does not mean a teammate completed work. ' +
  'NOT for invocation-only structured action/coordination or replacing a provider final. ' +
  'GOTCHA: targetCats and line-start mentions are merged; never add your own catId unless self-invocation is intended. ' +
  'Missing reply authorization cannot be repaired by dropping replyTo or choosing another source. Report held/errors honestly; do not retry authorization rejections. ' +
  'Typed local review facts remain available with localReviewVerdict, reviewedHeadSha, reviewSubjectRef, acceptedSourceRef, acceptedRevision and clientMessageId.';

const crossDescription =
  'Post and route a message to an explicit owner-authorized thread as a persistent agent. ' +
  'Use when initiating collaboration in another known thread or delivering its requested result. ' +
  'Requires threadId and at least one intended recipient via targetCats or line-start mention; discover catIds with get_thread_cats first. ' +
  'Output: a durable message and routing results; routed does not mean completed. ' +
  'NOT a structured action/coordination transfer or a way to bypass gpt-pro exact-source return authorization. ' +
  'GOTCHA: no source invocation is implied. Omit replyTo for a new root; for a dispatched return preserve its exact threadId/replyTo. ' +
  'agentKeyCatId is your identity, targetCats are recipients; do not implicitly target yourself or silently reroute disabled targets.';

/** Projection only: the API remains the owner of authorization and completion semantics. */
export function projectAgentKeyCollaborationContract(
  name: string,
  schema: Record<string, unknown>,
  description: string,
): { inputSchema: Record<string, unknown>; description: string } | undefined {
  if (name === 'cat_cafe_post_message' || name === 'cat_cafe_cross_post_message') {
    const { action: _action, proposedAction: _proposedAction, coordination: _coordination, ...supported } = schema;
    return {
      inputSchema: {
        ...supported,
        ...(name === 'cat_cafe_post_message'
          ? {
              streamDisposition: z
                .literal('independent')
                .optional()
                .describe('Agent-key messages are independent durable messages.'),
            }
          : {}),
      },
      description: name === 'cat_cafe_post_message' ? postDescription : crossDescription,
    };
  }
  if (name === 'cat_cafe_get_thread_cats' || name === 'cat_cafe_get_thread_context') {
    return {
      inputSchema: {
        ...schema,
        threadId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('Explicit owner-authorized thread ID. A persistent agent has no current invocation thread.'),
      },
      description:
        name === 'cat_cafe_get_thread_context'
          ? description.replace(
              'Pass threadId only to read a different thread; omit it for the current thread.',
              'Always provide threadId with agent-key auth; there is no current invocation thread.',
            )
          : description,
    };
  }
  return undefined;
}
