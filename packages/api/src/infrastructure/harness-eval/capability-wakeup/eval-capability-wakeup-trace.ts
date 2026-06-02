import {
  hasLivePreviewForInvocation,
  normalizeAuditCandidates,
  normalizeToolUsageCandidate,
  normalizeTranscriptToolUse,
  readPath,
} from './eval-capability-wakeup-trace-normalizers.js';
import {
  type CapabilityInvocationTrace,
  type CapabilityTrace,
  type CapabilityTraceInput,
} from './eval-capability-wakeup-types.js';

export function buildCapabilityTrace(input: CapabilityTraceInput): CapabilityTrace {
  const byInvocation = new Map<string, CapabilityInvocationTrace>();
  const transcriptInvocationIds = new Set<string>();
  const previewAvailability = input.previewAvailability ?? [];

  for (const evt of filterTranscriptEvents(input)) {
    const invocationId = evt.invocationId ?? `unknown-${evt.eventNo}`;
    transcriptInvocationIds.add(invocationId);
    const trace = ensureInvocation(byInvocation, invocationId, evt.eventNo, evt.t);
    trace.eventNoEnd = Math.max(trace.eventNoEnd, evt.eventNo);
    trace.endTime = Math.max(trace.endTime, evt.t);

    if (evt.event?.type === 'text' && typeof evt.event.content === 'string') {
      trace.textEvents.push({
        eventNo: evt.eventNo,
        invocationId,
        timestamp: evt.t,
        content: evt.event.content,
        tokenCount: estimateTokens(evt.event.content),
        structuredSignalCount: countStructuredSignals(evt.event.content),
      });
    }

    if (evt.event?.type === 'tool_use') {
      const normalized = normalizeTranscriptToolUse(evt.eventNo, evt.t, invocationId, evt.event);
      trace.transcriptToolUses.push(normalized);
      for (const path of normalized.referencedPaths) {
        trace.referencedPaths.push(path);
      }
      for (const path of normalized.changedFiles) {
        trace.changedFiles.push(path);
      }
    }
  }

  for (const event of input.toolEvents) {
    if (event.threadId !== input.threadId) continue;
    if (event.catId !== input.catId) continue;
    if (!transcriptInvocationIds.has(event.invocationId)) continue;
    if (event.sessionId !== input.sessionId && event.sessionId !== event.invocationId) continue;
    const trace = ensureInvocation(byInvocation, event.invocationId, undefined, event.timestamp);
    trace.startTime = Math.min(trace.startTime, event.timestamp);
    trace.endTime = Math.max(trace.endTime, event.timestamp);
    trace.toolEvents.push(event);
    const path = readPath(event.summary);
    if (path) trace.referencedPaths.push(path);
    const usageCandidate = normalizeToolUsageCandidate(event);
    if (usageCandidate) trace.normalizedUsageCandidates.push(usageCandidate);
  }

  for (const event of input.skillLoadEvents ?? []) {
    if (!transcriptInvocationIds.has(event.invocationId)) continue;
    if (event.sessionId !== input.sessionId && event.sessionId !== event.invocationId) continue;
    const trace = ensureInvocation(byInvocation, event.invocationId, undefined, event.timestamp);
    trace.startTime = Math.min(trace.startTime, event.timestamp);
    trace.endTime = Math.max(trace.endTime, event.timestamp);
    trace.skillLoadEvents.push(event);
  }

  const invocations = [...byInvocation.values()]
    .sort((a, b) => a.startTime - b.startTime || a.eventNoStart - b.eventNoStart)
    .map((trace, index) => ({
      ...trace,
      invocationIndex: index,
      changedFiles: unique(trace.changedFiles),
      referencedPaths: unique(trace.referencedPaths),
      normalizedUsageCandidates: trace.normalizedUsageCandidates,
      scenarioDetections: {
        ...trace.scenarioDetections,
        preview_live_port: hasLivePreviewForInvocation(
          previewAvailability,
          input.worktreeId,
          trace.startTime,
          trace.endTime,
        ),
      },
    }));

  return {
    kind: 'capability',
    sessionId: input.sessionId,
    threadId: input.threadId,
    catId: input.catId,
    ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
    ...(input.family ? { family: input.family } : {}),
    invocations,
    auditEvents: input.auditEvents ?? [],
    normalizedAuditCandidates: normalizeAuditCandidates(input.auditEvents ?? []),
    previewAvailability,
  };
}

function ensureInvocation(
  byInvocation: Map<string, CapabilityInvocationTrace>,
  invocationId: string,
  eventNo: number | undefined,
  timestamp: number,
): CapabilityInvocationTrace {
  const existing = byInvocation.get(invocationId);
  if (existing) {
    if (eventNo != null) {
      existing.eventNoStart = Math.min(existing.eventNoStart, eventNo);
      existing.eventNoEnd = Math.max(existing.eventNoEnd, eventNo);
    }
    existing.startTime = Math.min(existing.startTime, timestamp);
    existing.endTime = Math.max(existing.endTime, timestamp);
    return existing;
  }
  const created: CapabilityInvocationTrace = {
    invocationId,
    invocationIndex: 0,
    eventNoStart: eventNo ?? 0,
    eventNoEnd: eventNo ?? 0,
    startTime: timestamp,
    endTime: timestamp,
    changedFiles: [],
    referencedPaths: [],
    textEvents: [],
    transcriptToolUses: [],
    normalizedUsageCandidates: [],
    toolEvents: [],
    skillLoadEvents: [],
    scenarioDetections: {},
  };
  byInvocation.set(invocationId, created);
  return created;
}

function filterTranscriptEvents(input: CapabilityTraceInput) {
  return [...input.transcriptEvents]
    .filter(
      (event) =>
        event.threadId === input.threadId && event.catId === input.catId && event.sessionId === input.sessionId,
    )
    .sort((a, b) => a.eventNo - b.eventNo);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

function countStructuredSignals(text: string): number {
  let count = 0;
  count += text.match(/^\s*[-*]\s+/gm)?.length ?? 0;
  count += Math.floor((text.match(/```/g)?.length ?? 0) / 2);
  count += text.match(/^\s*\|.+\|\s*$/gm)?.length ?? 0;
  return count;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
