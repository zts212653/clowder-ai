/** Allow-list the private log surface, including native usage; never forward arbitrary provider/runner payloads. */
const numeric = [
  'elapsedMs',
  'phaseElapsedMs',
  'nativeCalls',
  'bodyChars',
  'rows',
  'costUsd',
  'durationMs',
  'runnerElapsedMs',
  'afterUsageMs',
  'outputChars',
  'examined',
  'supported',
  'rejected',
  'indeterminate',
  'unassessed',
  'runnerCalls',
  'nativeLaunches',
  'costReports',
  'reportedCostUsd',
] as const;
const batchNumeric = ['rows', 'bodyChars', 'remainingMs', 'runMs', 'abortAfterMs', 'cleanupAfterAbortMs'] as const;
const batchStages = new Set([
  'runner',
  'native-prepared',
  'native-launch',
  'native-init',
  'native-response',
  'native-usage',
  'native-output',
  'native-completed',
]);

function qualificationBatches(input: unknown) {
  if (!Array.isArray(input)) return;
  return input.slice(0, 2).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const batch = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    if (batch.batchIndex === 0 || batch.batchIndex === 1) result.batchIndex = batch.batchIndex;
    for (const key of batchNumeric) {
      const count = batch[key];
      if (typeof count === 'number' && Number.isFinite(count) && count >= 0) result[key] = count;
    }
    if (typeof batch.stage === 'string' && batchStages.has(batch.stage)) result.stage = batch.stage;
    if (typeof batch.outcome === 'string' && ['completed', 'failed', 'aborted'].includes(batch.outcome))
      result.outcome = batch.outcome;
    return [result];
  });
}
const tokenFields = [
  'input_tokens',
  'output_tokens',
  'thinking_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'ephemeral_5m_input_tokens',
  'ephemeral_1h_input_tokens',
  'web_search_requests',
  'web_fetch_requests',
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'webSearchRequests',
  'costUSD',
  'contextWindow',
  'maxOutputTokens',
] as const;
const phases = new Set([
  'visibility',
  'source-admission',
  'retrieval',
  'canonical-projection',
  'qualification',
  'final-revalidation',
  'qualification-unavailable',
  'native-prepared',
  'native-launch',
  'native-init',
  'native-response',
  'native-usage',
  'native-output',
  'native-completed',
]);
function counts(input: unknown, nested = true): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') return;
  const result: Record<string, unknown> = {};
  for (const key of tokenFields) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  if (nested)
    for (const key of ['cache_creation', 'server_tool_use', 'output_tokens_details']) {
      const value = counts((input as Record<string, unknown>)[key], false);
      if (value) result[key] = value;
    }
  return result;
}

export function privateMessageSearchTrace(trace: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    if (typeof trace.phase !== 'string' || !phases.has(trace.phase)) return;
    const result: Record<string, unknown> = { phase: trace.phase };
    if (trace.batchIndex === 0 || trace.batchIndex === 1) result.batchIndex = trace.batchIndex;
    if (trace.permissionMode === 'dontAsk') result.permissionMode = 'dontAsk';
    if (trace.effort === 'low') result.effort = 'low';
    for (const key of numeric) {
      const value = trace[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
    }
    if (trace.phase === 'qualification') {
      if (trace.reportedCostUsd === null) result.reportedCostUsd = null;
      const batches = qualificationBatches(trace.batches);
      if (batches) result.batches = batches;
    }
    if (trace.safeMode === true) result.safeMode = true;
    if (['complete', 'partial'].includes(String(trace.status))) result.status = trace.status;
    if (['Error', 'TimeoutError', 'AbortError'].includes(String(trace.reason))) result.reason = trace.reason;
    if (typeof trace.model === 'string' && /^[a-zA-Z0-9._:/-]{1,100}$/.test(trace.model)) result.model = trace.model;
    if (Array.isArray(trace.tools)) result.toolsCount = trace.tools.length;
    if (Array.isArray(trace.mcpServers)) result.mcpServersCount = trace.mcpServers.length;
    const usage = counts(trace.usage);
    if (usage) result.usage = usage;
    if (trace.modelUsage && typeof trace.modelUsage === 'object') {
      const models: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(trace.modelUsage).slice(0, 8))
        if (/^[a-zA-Z0-9._:/-]{1,100}$/.test(key)) models[key] = counts(value);
      result.modelUsage = models;
    }
    if (Array.isArray(trace.instructions))
      result.instructions = trace.instructions
        .slice(0, 2)
        .flatMap((row) =>
          row &&
          ['--system-prompt-file', '--append-system-prompt-file'].includes(row.decision) &&
          typeof row.chars === 'number' &&
          Number.isFinite(row.chars) &&
          /^[a-f0-9]{64}$/.test(row.sha256)
            ? [{ decision: row.decision, chars: row.chars, sha256: row.sha256 }]
            : [],
        );
    return result;
  } catch {
    return;
  } // Hostile getter/observer must not own result/error semantics.
}
