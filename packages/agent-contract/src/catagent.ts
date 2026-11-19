import { z } from 'zod';

export const CAT_AGENT_MAX_TOOL_INPUT_BYTES = 65_536;

const usage = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
});
const textBlock = z.object({ type: z.literal('text'), text: z.string() });
const toolBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});
const blockIndex = z.number().int().nonnegative();

export const catAgentSseFrameSchema = z.union([
  z.object({ kind: z.literal('event'), name: z.string(), data: z.string() }),
  z.object({ kind: z.literal('transport_error'), error: z.string() }),
]);

export const catAgentStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), text: z.string(), blockIndex }),
  z.object({ type: z.literal('content_block_complete'), block: z.union([textBlock, toolBlock]), blockIndex }),
  z.object({ type: z.literal('usage_update'), inputUsage: usage.optional(), outputTokens: z.number().optional() }),
  z.object({ type: z.literal('stop'), stopReason: z.string().nullable() }),
  z.object({ type: z.literal('stream_error'), error: z.string() }),
]);

export type AnthropicUsage = z.infer<typeof usage>;
export type AnthropicTextBlock = z.infer<typeof textBlock>;
export type AnthropicToolUseBlock = z.infer<typeof toolBlock>;
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;
export type CatAgentSseFrame = z.infer<typeof catAgentSseFrameSchema>;
export type CatAgentStreamEvent = z.infer<typeof catAgentStreamEventSchema>;
