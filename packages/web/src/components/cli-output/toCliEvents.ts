import { cleanCliToolLabel, projectCliToolUseLabel } from '@cat-cafe/shared';
import type { CliEvent, ToolEvent } from '@/stores/chat-types';

interface ToolProjectionState {
  events: CliEvent[];
  skipNextResult: boolean;
}

function appendToolEvent(event: ToolEvent, state: ToolProjectionState): void {
  if (event.type === 'tool_use') {
    state.skipNextResult = cleanCliToolLabel(event.label) === 'unknown';
    if (state.skipNextResult) return;
    state.events.push({
      id: event.id,
      kind: event.type,
      timestamp: event.timestamp,
      label: projectCliToolUseLabel(event.label, event.detail),
      detail: event.detail,
    });
    return;
  }
  if (state.skipNextResult) {
    state.skipNextResult = false;
    return;
  }
  state.events.push({
    id: event.id,
    kind: event.type,
    timestamp: event.timestamp,
    label: event.label,
    detail: event.detail,
  });
}

/** F097: Adapt existing ToolEvent[] + stream content → CliEvent[] unified timeline.
 *  Phase A: N tool events + 1 text block. Phase B: backend pushes CliEvent[] directly. */
export function toCliEvents(toolEvents: ToolEvent[] | undefined, streamContent: string | undefined): CliEvent[] {
  const events: CliEvent[] = [];

  if (toolEvents) {
    // F148: collect IDs of "unknown" tool_use events so we can also skip their paired tool_result.
    // CliOutputBlock pairs toolUses[i] with toolResults[i] by position, so skipping a use
    // without its result would mis-pair all subsequent rows.
    const state: ToolProjectionState = { events, skipNextResult: false };
    for (const te of toolEvents) {
      appendToolEvent(te, state);
    }
  }

  if (streamContent?.trim()) {
    events.push({
      id: 'stdout-text',
      kind: 'text',
      timestamp: events.length > 0 ? events[events.length - 1].timestamp + 1 : Date.now(),
      content: streamContent,
    });
  }

  return events;
}
