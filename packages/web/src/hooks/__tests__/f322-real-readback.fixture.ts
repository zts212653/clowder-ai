import { readFileSync } from 'node:fs';
import { readMessageOutputLayout } from '@cat-cafe/shared';
import { z } from 'zod';
import projected from '../../../test/fixtures/f322-readback.public.json';

const extra = z.object({
  outputLayout: z.unknown().transform(readMessageOutputLayout).optional(),
  stream: z.object({ invocationId: z.string(), turnInvocationId: z.string().optional() }).optional(),
});
const tools = z.array(
  z.object({
    id: z.string(),
    executionRef: z.string().optional(),
    type: z.enum(['tool_use', 'tool_result']),
    label: z.string().default(''),
    detail: z.string().optional(),
    timestamp: z.number(),
    toolUseId: z.string().optional(),
  }),
);
const message = z.object({
  id: z.string(),
  type: z.literal('assistant'),
  catId: z.string(),
  content: z.string(),
  origin: z.literal('stream'),
  timestamp: z.number(),
  extra,
  toolEvents: tools.optional(),
  isDraft: z.boolean().optional(),
});
const event = z.object({
  type: z.string(),
  catId: z.string(),
  timestamp: z.number(),
  content: z.string().optional(),
  invocationId: z.string().optional(),
  turnInvocationId: z.string().optional(),
  origin: z.enum(['stream', 'callback']).optional(),
  textMode: z.enum(['append', 'replace']).optional(),
  toolName: z.string().optional(),
  toolUseId: z.string().optional(),
  toolEventId: z.string().optional(),
  toolExecutionRef: z.string().optional(),
  extra: extra.optional(),
});
const stationSchema = z.object({
  v: z.literal(1),
  redisPort: z.literal(6398),
  traces: z
    .array(
      z.object({
        route: z.enum(['serial', 'parallel']),
        threadId: z.string(),
        childId: z.string(),
        live: z.array(event),
        api: message,
        draft: z.object({ api: message }),
      }),
    )
    .length(2),
});

// The default is a public-safe derived projection of the real Redis6398 journey:
// event order, controlled body/hash and layout relations are retained; instance
// IDs and wall clocks are anonymized, and unrelated private metadata is omitted.
// The original capture stays privately archived. This override still accepts a
// fresh actual journey artifact in this exact consumer suite before archiving.
const input = process.env.F322_READBACK_ARTIFACT;
export const stations = stationSchema.parse(input ? JSON.parse(readFileSync(input, 'utf8')) : projected).traces;
