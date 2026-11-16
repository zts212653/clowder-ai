import { createHash } from 'node:crypto';
import { estimateTokens } from '../../../../utils/token-counter.js';
import { hasExplicitTextContext } from '../watcher-request-context.js';
import { WATCHER_TURN_RESERVE_TOKENS } from './watcher-context-budget.js';

export interface WatcherContextEstimate {
  inputUpperBound: number;
  accountingBasis: 'explicit_text' | 'reported_continuation' | 'conservative';
  serializedRequestTokens: number;
  priorOutputReserve: number;
  previousInputTokens?: number;
  previousOutputTokens?: number;
  retainedInputUpperBound?: number;
  newTextUpperBound?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function localEnvelope(body: Record<string, unknown>): string | undefined {
  if (body.conversation != null || body.context_management != null || body.prompt != null) return undefined;
  const { input: _input, max_output_tokens: _reserve, ...envelope } = body;
  return fingerprint(envelope);
}
function generatedKey(item: unknown): string | undefined {
  if (!record(item)) return undefined;
  const { id: _id, ...retained } = item;
  if (item.type === 'reasoning') {
    if (
      typeof item.encrypted_content !== 'string' ||
      !item.encrypted_content ||
      !Array.isArray(item.summary) ||
      !Object.keys(item).every((key) => ['type', 'id', 'summary', 'content', 'encrypted_content'].includes(key)) ||
      (item.content != null && (!Array.isArray(item.content) || item.content.length !== 0))
    )
      return undefined;
    // Native Responses serialization omits generated IDs and supplies an empty reasoning content slot.
    delete retained.content;
  } else if (
    !['message', 'function_call', 'custom_tool_call'].includes(String(item.type)) ||
    !hasExplicitTextContext({ input: [item] })
  )
    return undefined;
  return fingerprint(retained);
}

interface Receipt {
  envelope: string;
  input: string[];
  output: string[];
  inputTokens: number;
  outputTokens: number;
  retainedInputUpperBound: number;
}

/** One bounded, in-memory completed-request receipt. No raw prompt or encrypted value is retained. */
export function createWatcherRequestAccounting() {
  let previousOutputs = 0;
  let receipt: Receipt | undefined;
  return {
    estimate(body: Record<string, unknown>): WatcherContextEstimate {
      const serializedRequestTokens = estimateTokens(JSON.stringify(body));
      const items = Array.isArray(body.input) ? body.input.length : 1;
      const tools = Array.isArray(body.tools) ? body.tools.length : 0;
      const explicit = hasExplicitTextContext(body);
      const priorOutputReserve = explicit ? 0 : previousOutputs;
      const conservative: WatcherContextEstimate = {
        accountingBasis: explicit ? 'explicit_text' : 'conservative',
        serializedRequestTokens,
        priorOutputReserve,
        inputUpperBound: serializedRequestTokens + priorOutputReserve + 1024 + 64 * (items + tools),
      };
      if (explicit || !receipt || !Array.isArray(body.input) || localEnvelope(body) !== receipt.envelope)
        return conservative;
      const currentInput = body.input;
      const generatedAt = receipt.input.length;
      const addedAt = generatedAt + receipt.output.length;
      if (
        body.input.length < addedAt ||
        !receipt.input.every((key, index) => fingerprint(currentInput[index]) === key) ||
        !receipt.output.every((key, index) => generatedKey(currentInput[generatedAt + index]) === key)
      )
        return conservative;
      const added = body.input.slice(addedAt);
      if (!hasExplicitTextContext({ input: added })) return conservative;
      const newTextUpperBound = estimateTokens(JSON.stringify(added)) + 64 * (receipt.output.length + added.length);
      return {
        accountingBasis: 'reported_continuation',
        serializedRequestTokens,
        priorOutputReserve: 0,
        previousInputTokens: receipt.inputTokens,
        previousOutputTokens: receipt.outputTokens,
        retainedInputUpperBound: receipt.retainedInputUpperBound,
        newTextUpperBound,
        inputUpperBound: receipt.retainedInputUpperBound + receipt.outputTokens + newTextUpperBound + 1024,
      };
    },
    completed(body: Record<string, unknown>, response: unknown, complete: boolean, estimate: WatcherContextEstimate) {
      const usage = record(response) && record(response.usage) ? response.usage : undefined;
      previousOutputs += valid(usage?.output_tokens) ? usage.output_tokens : WATCHER_TURN_RESERVE_TOKENS;
      receipt = undefined;
      if (
        !complete ||
        estimate.accountingBasis === 'conservative' ||
        !record(response) ||
        !valid(usage?.input_tokens) ||
        !valid(usage?.output_tokens) ||
        !Array.isArray(body.input) ||
        body.input.length > 512 ||
        !Array.isArray(response.output) ||
        !response.output.length ||
        response.output.length > 512
      )
        return;
      const envelope = localEnvelope(body);
      if (!envelope) return;
      const output = response.output.map(generatedKey);
      if (output.some((key) => key === undefined)) return;
      receipt = {
        envelope,
        input: body.input.map(fingerprint),
        output: output as string[],
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        // Start only from a transparent root; retain every verified append even if later usage renders less history.
        retainedInputUpperBound: Math.max(usage.input_tokens, estimate.inputUpperBound - 1024),
      };
    },
    unknownOutput() {
      previousOutputs += WATCHER_TURN_RESERVE_TOKENS;
      receipt = undefined;
    },
    clear() {
      receipt = undefined;
    },
  };
}
