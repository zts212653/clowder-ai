import { z } from 'zod';
import type { CliDiagnostics } from '../../../utils/cli-diagnostics.js';
import { textDigest, validateWatcherCase, type WatcherSource, watcherInput } from './protocol.js';
import type { OfflineUsage } from './usage.js';

export const watcherDecisionSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('read'), sourceIds: z.array(z.string().min(1)).min(1).max(3) }).strict(),
    z.object({ kind: z.literal('silent') }).strict(),
    z
      .object({
        kind: z.literal('hint'),
        sourceId: z.string().min(1),
        message: z.string().min(1).max(500),
        basis: z.string().min(1).max(500),
        recipient: z.enum(['working_cat', 'owner_and_working_cat']),
        ownerReason: z.enum(['before_asking_owner', 'spinning_in_place', 'goal_drift']).nullable(),
      })
      .strict(),
  ])
  .refine(
    (item) =>
      item.kind !== 'hint' ||
      (item.recipient === 'working_cat' ? item.ownerReason === null : item.ownerReason !== null),
    'recipient_reason_mismatch',
  );
export type WatcherDecision = z.infer<typeof watcherDecisionSchema>;
export interface WatcherCall {
  success: boolean;
  text: string;
  elapsedMs: number;
  requestedModel: string;
  servedModel: string | null;
  usage: readonly OfflineUsage[];
  nativeText?: string;
  instructionDigest?: string;
  nativeToolSurface?: 'empty' | 'output_only' | 'restricted_launch' | 'unexpected';
  nativeTools?: string[];
  nativeMcpServers?: string[];
  nativeCommand?: string;
  nativeEffort?: string | null;
  launchDigest?: string;
  diagnostics?: ({ code?: string } & Partial<Pick<CliDiagnostics, 'publicSummary' | 'safeExcerpt' | 'debugRef'>>)[];
  error?: string;
}
export interface WatcherAdapter {
  next(prompt: string, signal?: AbortSignal): Promise<WatcherCall>;
}
export interface WatcherCaseResult {
  caseId: string;
  inputDigest: string;
  state: 'complete' | 'failed';
  calls: WatcherCall[];
  readSourceIds: string[];
  readBytes: number;
  decision?: Exclude<WatcherDecision, { kind: 'read' }>;
  handoff?: {
    text: string;
    sourceRef: string;
    revision: string;
    promptBytes: number;
    linkedSourceBytes: number;
    delivered: false;
  };
  reason?: string;
}
export interface WatcherBudget {
  maxCalls: number;
  maxSources: number;
  maxReadBytes: number;
}
export const DEFAULT_WATCHER_BUDGET: WatcherBudget = { maxCalls: 4, maxSources: 3, maxReadBytes: 24_000 };

export async function runWatcherCase(
  input: unknown,
  adapter: WatcherAdapter,
  budget = DEFAULT_WATCHER_BUDGET,
  signal?: AbortSignal,
): Promise<WatcherCaseResult> {
  const sample = validateWatcherCase(input);
  const result: WatcherCaseResult = {
    caseId: sample.id,
    inputDigest: textDigest(JSON.stringify(sample)),
    state: 'failed',
    calls: [],
    readSourceIds: [],
    readBytes: 0,
  };
  if (
    ![budget.maxCalls, budget.maxSources, budget.maxReadBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
    budget.maxCalls > 10 ||
    budget.maxSources > 20 ||
    budget.maxReadBytes > 100_000
  )
    throw new Error('invalid_watcher_budget');
  const sources = new Map(sample.sources.map((item) => [item.id, item]));
  const reads: WatcherSource[] = [];
  for (let index = 0; index < budget.maxCalls; index++) {
    if (signal?.aborted) {
      result.reason = 'cancelled';
      return result;
    }
    let call: WatcherCall;
    try {
      call = await adapter.next(JSON.stringify(watcherInput(sample, reads)), signal);
    } catch {
      result.reason = signal?.aborted ? 'cancelled' : 'adapter_unavailable';
      return result;
    }
    result.calls.push(call);
    if (!call.success) {
      result.reason = signal?.aborted ? 'cancelled' : 'native_call_failed';
      return result;
    }
    let decision: WatcherDecision;
    try {
      if (Buffer.byteLength(call.text) > 8000) throw new Error('response_too_large');
      decision = watcherDecisionSchema.parse(JSON.parse(call.text));
    } catch {
      result.reason = 'invalid_response';
      return result;
    }
    if (decision.kind !== 'read') {
      if (decision.kind === 'hint' && !sources.has(decision.sourceId)) {
        result.reason = 'source_outside_snapshot';
        return result;
      }
      if (decision.kind === 'hint' && !result.readSourceIds.includes(decision.sourceId)) {
        result.reason = 'source_not_read';
        return result;
      }
      result.decision = decision;
      if (decision.kind === 'hint') {
        const source = sources.get(decision.sourceId);
        if (!source) throw new Error('validated_source_missing');
        const text = `守望 · 先例提示：${decision.message}\n来源：${source.sourceRef}@${source.revision}\n是否适用由你判断；这条提示不带授权，也不用在聊天里回复。`;
        result.handoff = {
          text,
          sourceRef: source.sourceRef,
          revision: source.revision,
          promptBytes: Buffer.byteLength(text),
          linkedSourceBytes: Buffer.byteLength(source.text),
          delivered: false,
        };
      }
      result.state = 'complete';
      return result;
    }
    const selected: WatcherSource[] = [];
    for (const id of decision.sourceIds) {
      const item = sources.get(id);
      if (!item) {
        result.reason = 'source_outside_snapshot';
        return result;
      }
      if (result.readSourceIds.includes(id) || selected.some((source) => source.id === id)) {
        result.reason = 'source_already_read';
        return result;
      }
      selected.push(item);
    }
    const newBytes = selected.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
    if (reads.length + selected.length > budget.maxSources || result.readBytes + newBytes > budget.maxReadBytes) {
      result.reason = 'read_budget_exceeded';
      return result;
    }
    reads.push(...selected);
    result.readSourceIds.push(...selected.map((item) => item.id));
    result.readBytes += newBytes;
  }
  result.reason = 'call_budget_exceeded';
  return result;
}
