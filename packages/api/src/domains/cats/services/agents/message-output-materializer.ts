import { createHash } from 'node:crypto';
import {
  MAX_MESSAGE_OUTPUT_REFS,
  type MessageOutputBoundaryRun,
  type MessageOutputHostTail,
  type MessageOutputLayoutV1,
  type MessageOutputOrderRef,
  type MessageOutputRun,
  type MessageOutputSettlement,
} from '@cat-cafe/shared';
import { normalizeJsonUnicode } from '../../../../utils/json-unicode.js';
import type { MessageOutputState, OutputTextRun } from './message-output-state.js';

function separator(previous: string, next: string): string {
  if (!previous || !next) return '';
  const trailing = /\n{0,2}$/.exec(previous)?.[0].length ?? 0;
  const leading = /^\n{0,2}/.exec(next)?.[0].length ?? 0;
  return '\n'.repeat(Math.max(0, 2 - trailing - leading));
}

interface OutputProjection {
  content: string;
  runs: MessageOutputRun[];
  order: MessageOutputOrderRef[];
  reason?: MessageOutputState['reason'];
  hostTail?: MessageOutputHostTail;
}

function appendText(projection: OutputProjection, entry: OutputTextRun): void {
  const glue = entry.paragraphBoundary ? separator(projection.content, entry.text) : '';
  const start = projection.content.length;
  projection.content += glue + entry.text;
  if (!entry.identity || !entry.channel) projection.reason ??= 'unknown_output';
  else if (!entry.complete) projection.reason ??= 'incomplete';
  else if (projection.content.length > start) {
    const id = `run-${projection.runs.length}`;
    projection.runs.push({
      id,
      identity: entry.identity,
      channel: entry.channel,
      complete: true,
      start,
      end: projection.content.length,
      gluePrefixLength: glue.length as 0 | 1 | 2,
    });
    projection.order.push({ kind: 'run', runId: id });
  }
}

function projectEntries(state: MessageOutputState): OutputProjection {
  const projection: OutputProjection = {
    content: '',
    runs: [],
    order: [],
    ...(state.reason ? { reason: state.reason } : {}),
  };
  for (const entry of state.entries) {
    if (entry.kind === 'text') appendText(projection, entry);
    else if (entry.kind === 'host') {
      const start = projection.content.length;
      projection.content += entry.text;
      projection.hostTail = {
        kind: entry.observation.kind,
        producer: entry.observation.producer,
        basis: entry.observation.basis,
        start,
        end: projection.content.length,
        gluePrefixLength: 2,
      };
    } else {
      projection.order.push({ kind: 'tool', toolEventId: entry.toolEventId, executionRef: entry.executionRef });
      if (!entry.toolEventId || !entry.executionRef) projection.reason ??= 'conflict';
    }
  }
  if (projection.order.length > MAX_MESSAGE_OUTPUT_REFS) projection.reason = 'oversized';
  if (!projection.runs.some((run) => run.channel === 'final')) projection.reason ??= 'no_final';
  return projection;
}

/** The event sequence proves a display boundary, without inventing native IDs or phases. */
function toolBoundary(state: MessageOutputState, settlement: MessageOutputSettlement | undefined) {
  if (!settlement?.succeeded || settlement.nativePhases) return undefined;
  if (state.reason && !['unknown_output', 'incomplete', 'no_final', 'content_changed'].includes(state.reason))
    return undefined;
  const runs: MessageOutputBoundaryRun[] = [];
  const order: MessageOutputOrderRef[] = [];
  let content = '';
  for (const entry of state.entries) {
    if (entry.kind === 'tool') {
      if (!entry.toolEventId || entry.executionRef !== state.owner.turnInvocationId) return undefined;
      order.push({ kind: 'tool', toolEventId: entry.toolEventId, executionRef: entry.executionRef });
    } else {
      if (entry.kind !== 'text' || entry.identity || entry.channel) return undefined;
      const glue = entry.paragraphBoundary ? separator(content, entry.text) : '';
      const start = content.length;
      content += glue + entry.text;
      if (content.length === start) continue;
      const id = `run-${runs.length}`;
      runs.push({ id, channel: 'commentary', start, end: content.length, gluePrefixLength: glue.length as 0 | 1 | 2 });
      order.push({ kind: 'run', runId: id });
    }
  }
  let lastTool = -1;
  order.forEach((entry, index) => {
    if (entry.kind === 'tool') lastTool = index;
  });
  const answerIds = new Set(order.slice(lastTool + 1).flatMap((entry) => (entry.kind === 'run' ? [entry.runId] : [])));
  if (lastTool < 0 || !runs.some((run) => answerIds.has(run.id) && content.slice(run.start, run.end).trim()))
    return undefined;
  return {
    basis: 'successful_turn_last_tool' as const,
    runs: runs.map((run) => ({
      ...run,
      channel: answerIds.has(run.id) ? ('final' as const) : ('commentary' as const),
    })),
    order,
  };
}

/** Build offsets from the normalized content actually published, never a second body. */
export function materializeMessageOutput(
  state: MessageOutputState,
  settlement?: MessageOutputSettlement,
): {
  content: string;
  layout: MessageOutputLayoutV1;
} {
  const { content: raw, runs, order, reason, hostTail } = projectEntries(state);
  const content = normalizeJsonUnicode(raw);
  const common = {
    v: 1 as const,
    owner: state.owner,
    contentRevision: { length: content.length, sha256: createHash('sha256').update(content, 'utf8').digest('hex') },
  };
  const boundary = reason ? toolBoundary(state, settlement) : undefined;
  return {
    content,
    layout: boundary
      ? { ...common, status: 'available', ...boundary }
      : reason
        ? { ...common, status: 'unavailable', reason }
        : { ...common, status: 'available', runs, order, ...(hostTail ? { hostTail } : {}) },
  };
}
