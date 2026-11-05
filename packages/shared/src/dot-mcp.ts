import { z } from 'zod';
import { deploymentDefaults } from './deployment-defaults.js';

export const dotEventRefSchema = z.object({ event_id: z.string().regex(/^dot_evt_[a-f0-9]{64}$/) }).strict();
export const dotSubscriptionArguments = z
  .object({ attempt_id: z.string().min(1).max(512), pairing_code: z.string().min(16).max(128) })
  .strict();
export const dotReplyArguments = dotEventRefSchema.extend({ content: z.string().min(1).max(50000) });
export const dotImageArguments = dotEventRefSchema.extend({
  publication_key: z.string().min(1).max(128),
  png_base64: z.string().min(1).max(13981016),
  alt: z.string().max(500).optional(),
});
export const dotAskMetadataSchema = z
  .object({
    v: z.literal(1),
    ownerUserId: z.string().min(1),
    attemptId: z.string().min(1),
    subscriptionId: z.string().min(1),
    recipientCatIds: z.array(z.string().min(1)).min(1).max(8),
    requestKey: z.string().min(1),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const dotAskArguments = z
  .object({
    attempt_id: z.string().min(1).max(512),
    thread_id: z.string().min(1).max(512),
    target_cat_ids: z.array(z.string().min(1).max(128)).min(1).max(8),
    content: z.string().trim().min(1).max(50000),
    client_message_id: z.string().min(1).max(128),
  })
  .strict();
const eventRef = { type: 'string', pattern: '^dot_evt_[a-f0-9]{64}$' };
export const DOT_TOOLS = [
  {
    name: 'cat_cafe_dot_read_source',
    description: `Use when: a dot.summoned event asks you to join a ${deploymentDefaults.brand.displayName} conversation. NOT for: arbitrary threads or another cat’s identity. Output: the exact original message, recent visible context, query scope and observation time. GOTCHA: call separately for every event; batching never changes its source.`,
    inputSchema: {
      type: 'object',
      properties: { event_id: eventRef },
      required: ['event_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'cat_cafe_dot_reply',
    description:
      'Use when: you have read this summon and are ready to answer in its original conversation. NOT for: selecting a different author, thread or user approval. Output: the durable source-bound reply message ID. GOTCHA: retries recover the same reply; a webhook acknowledgement alone does not authorize an unread-source reply.',
    inputSchema: {
      type: 'object',
      properties: { event_id: eventRef, content: { type: 'string', minLength: 1, maxLength: 50000 } },
      required: ['event_id', 'content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'cat_cafe_dot_publish_image',
    description: `Use when: delivering a generated original PNG to the exact conversation that summoned you. NOT for: Library IDs, private download links, local server paths, SVG or user impersonation. Output: a durable image publication and its original reply message. GOTCHA: obtain actual file bytes through authorized file tools; send at most 10 MiB per PNG and 8 images per event. Reuse each image’s stable publication_key for retries; failed writes keep that slot. ${deploymentDefaults.brand.displayName} renders and retains the original without user download/upload.`,
    inputSchema: {
      type: 'object',
      properties: {
        event_id: eventRef,
        publication_key: { type: 'string', minLength: 1, maxLength: 128 },
        png_base64: { type: 'string', maxLength: 13981016 },
        alt: { type: 'string', maxLength: 500 },
      },
      required: ['event_id', 'publication_key', 'png_base64'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'cat_cafe_dot_ask',
    description: `Ask authorized house cats as the paired dot through the existing ${deploymentDefaults.brand.displayName} connection. Use when: initiating a question or collaboration, 主动问家猫. NOT for: answering a dot.summoned event (use dot_reply), impersonating the owner, changing work authority or choosing an author. Output: a durable gpt-dot message and routing receipt; actual replies return to the same subscription. GOTCHA: generic post_message uses Pro identity, not dot. Prepare the current dot subscription once; reuse client_message_id for retries without changing thread, recipients or text.`,
    inputSchema: {
      type: 'object',
      properties: {
        attempt_id: { type: 'string', minLength: 1, maxLength: 512 },
        thread_id: { type: 'string', minLength: 1, maxLength: 512 },
        target_cat_ids: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 128 },
          minItems: 1,
          maxItems: 8,
        },
        content: { type: 'string', minLength: 1, maxLength: 50000 },
        client_message_id: { type: 'string', minLength: 1, maxLength: 128 },
      },
      required: ['attempt_id', 'thread_id', 'target_cat_ids', 'content', 'client_message_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
] as const;

export const DOT_EVENT_DEFINITION = {
  name: 'dot.summoned',
  description: `An admitted ${deploymentDefaults.brand.displayName} summon for this connected dot. Read the referenced original message; reply to that same source.`,
  delivery: ['webhook'],
  inputSchema: {
    type: 'object',
    properties: {
      attempt_id: { type: 'string' },
      pairing_code: { type: 'string' },
    },
    required: ['attempt_id', 'pairing_code'],
    additionalProperties: false,
  },
  payloadSchema: {
    type: 'object',
    properties: {
      event_id: eventRef,
      thread_id: { type: 'string' },
      source_message_id: { type: 'string' },
      dispatch_invocation_id: { type: 'string' },
    },
    required: ['event_id', 'thread_id', 'source_message_id', 'dispatch_invocation_id'],
    additionalProperties: false,
  },
};
