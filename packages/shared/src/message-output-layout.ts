import { z } from 'zod';
import {
  type HostSignatureOutput,
  MAX_MESSAGE_OUTPUT_REFS,
  MAX_MESSAGE_OUTPUT_RUNS,
  type MessageOutputBoundaryRun,
  type MessageOutputHostTail,
  type MessageOutputLayoutV1,
} from './types/message-output-layout.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value);
const identity = z.object({ provider: id, runtimeSessionId: id, turnId: id, nativeId: id }).strict();
const range = {
  id,
  channel: z.enum(['commentary', 'final']),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  gluePrefixLength: z.union([z.literal(0), z.literal(1), z.literal(2)]),
};
const run = z.object({ ...range, identity, complete: z.literal(true) }).strict();
const boundaryRun = z.object(range).strict();
const ref = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), runId: id }).strict(),
  z.object({ kind: z.literal('tool'), toolEventId: id, executionRef: id }).strict(),
]);
const hostSignature = z
  .object({
    v: z.literal(1),
    kind: z.literal('cat_signature'),
    producer: z.literal('codex_stream_finalizer'),
    role: z.literal('answer_suffix'),
    basis: z.enum(['runtime_canonical', 'provider_observed_fallback']),
  })
  .strict();
const hostTail = z
  .object({
    kind: z.literal('cat_signature'),
    producer: z.literal('codex_stream_finalizer'),
    basis: z.enum(['runtime_canonical', 'provider_observed_fallback']),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    gluePrefixLength: z.literal(2),
  })
  .strict();
export function readHostSignatureOutput(value: unknown): HostSignatureOutput | undefined {
  const result = hostSignature.safeParse(value);
  return result.success ? result.data : undefined;
}

const common = {
  v: z.literal(1),
  owner: z.object({ threadId: id, catId: id, turnInvocationId: id }).strict(),
  contentRevision: z
    .object({ length: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict(),
};
const schema = z.union([
  z
    .object({
      ...common,
      status: z.literal('available'),
      runs: z.array(run).min(1).max(MAX_MESSAGE_OUTPUT_RUNS),
      order: z.array(ref).min(1).max(MAX_MESSAGE_OUTPUT_REFS),
      hostTail: hostTail.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      status: z.literal('available'),
      basis: z.literal('successful_turn_last_tool'),
      runs: z.array(boundaryRun).min(1).max(MAX_MESSAGE_OUTPUT_RUNS),
      order: z.array(ref).min(1).max(MAX_MESSAGE_OUTPUT_REFS),
    })
    .strict(),
  z
    .object({
      ...common,
      status: z.literal('unavailable'),
      reason: z.enum([
        'unknown_output',
        'incomplete',
        'no_final',
        'conflict',
        'oversized',
        'content_changed',
        'callback',
        'whole_body_replaced',
      ]),
    })
    .strict(),
]);

function completeRanges(
  runs: readonly MessageOutputBoundaryRun[],
  length: number,
  tail?: MessageOutputHostTail,
): boolean {
  let cursor = 0;
  const ids = new Set<string>();
  for (const entry of runs) {
    if (
      entry.start !== cursor ||
      entry.end <= entry.start ||
      entry.gluePrefixLength > entry.end - entry.start ||
      ids.has(entry.id)
    )
      return false;
    ids.add(entry.id);
    cursor = entry.end;
  }
  if (tail)
    return (
      cursor === tail.start && tail.end === length && tail.end - tail.start > 2 && runs.at(-1)?.channel === 'final'
    );
  return cursor === length && runs.some((entry) => entry.channel === 'final');
}

function completeOrder(layout: Extract<MessageOutputLayoutV1, { status: 'available' }>): boolean {
  let cursor = 0;
  const tools = new Set<string>();
  for (const entry of layout.order) {
    if (entry.kind === 'run') {
      if (entry.runId !== layout.runs[cursor]?.id) return false;
      cursor += 1;
    } else {
      if (tools.has(entry.toolEventId)) return false;
      tools.add(entry.toolEventId);
    }
  }
  return cursor === layout.runs.length;
}

function validBoundary(layout: Extract<MessageOutputLayoutV1, { status: 'available' }>): boolean {
  if (layout.basis !== 'successful_turn_last_tool') return true;
  let lastTool = -1;
  layout.order.forEach((entry, index) => {
    if (entry.kind === 'tool') lastTool = index;
  });
  if (lastTool < 0) return false;
  const byId = new Map(layout.runs.map((entry) => [entry.id, entry]));
  return layout.order.every(
    (entry, index) =>
      entry.kind === 'tool' || byId.get(entry.runId)?.channel === (index > lastTool ? 'final' : 'commentary'),
  );
}

/** Structural wire guard; content hash, actual owner and tool membership are checked by each consumer. */
export function readMessageOutputLayout(value: unknown): MessageOutputLayoutV1 | undefined {
  const result = schema.safeParse(value);
  if (!result.success) return undefined;
  const layout = result.data as MessageOutputLayoutV1;
  if (
    layout.status === 'available' &&
    (!completeRanges(layout.runs, layout.contentRevision.length, layout.hostTail) ||
      !completeOrder(layout) ||
      !validBoundary(layout))
  )
    return undefined;
  return layout;
}
