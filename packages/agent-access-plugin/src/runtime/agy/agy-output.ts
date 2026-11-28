import { Readable } from 'node:stream';
import { agentAccessAgyTurnRequestSchema } from '@clowder-ai/agent-contract/agy';
import { z } from 'zod';
import { parseAgyStreamJsonLine, summarizeAgyStreamJsonTurn } from './agy-stream-json-parser.js';

const projectionSchema = z.object({ source: z.instanceof(Readable), signal: z.instanceof(AbortSignal) });
const frameSchema = z.object({ sequence: z.number().int().nonnegative(), line: z.string().optional() });

export async function* projectAgyOutput(input: unknown) {
  const { source, signal } = projectionSchema.parse(input);
  for await (const raw of source) {
    signal.throwIfAborted();
    const { sequence, line } = frameSchema.parse(raw);
    const event = line === undefined ? null : parseAgyStreamJsonLine(line);
    yield { sequence, ...(event?.kind === 'step' ? { step: event } : {}) };
  }
}

export function summarizeAgyTurn(input: unknown) {
  const { lines, terminalPolicyRejected } = agentAccessAgyTurnRequestSchema.parse(input);
  return summarizeAgyStreamJsonTurn(lines, terminalPolicyRejected);
}
