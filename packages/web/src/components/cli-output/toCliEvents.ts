import { cleanCliToolLabel, projectCliToolUseLabel, withFinalizedCliToolInputs } from '@cat-cafe/shared';
import type { CliEvent, ToolEvent } from '@/stores/chat-types';

/** The same visibility rule serves timeline projection and the cheap existence check. */
function* visibleToolEvents(events: readonly ToolEvent[]) {
  let skipNextResult = false;
  for (const event of events) {
    if (event.type === 'tool_use') {
      skipNextResult = cleanCliToolLabel(event.label) === 'unknown';
      if (skipNextResult) continue;
    } else if (skipNextResult) {
      skipNextResult = false;
      continue;
    }
    yield event;
  }
}

export function hasCliEvents(toolEvents: ToolEvent[] | undefined, streamContent: string | undefined): boolean {
  return Boolean(streamContent?.trim()) || !visibleToolEvents(toolEvents ?? []).next().done;
}

/** F097: Adapt existing ToolEvent[] + stream content → CliEvent[] unified timeline.
 *  Phase A: N tool events + 1 text block. Phase B: backend pushes CliEvent[] directly. */
export function toCliEvents(toolEvents: ToolEvent[] | undefined, streamContent: string | undefined): CliEvent[] {
  const events: CliEvent[] = [];

  if (toolEvents) {
    // F148: collect IDs of "unknown" tool_use events so we can also skip their paired tool_result.
    // CliOutputBlock pairs toolUses[i] with toolResults[i] by position, so skipping a use
    // without its result would mis-pair all subsequent rows.
    for (const event of visibleToolEvents(withFinalizedCliToolInputs(toolEvents))) {
      events.push({
        id: event.id,
        kind: event.type,
        timestamp: event.timestamp,
        label: event.type === 'tool_use' ? projectCliToolUseLabel(event.label, event.detail) : event.label,
        detail: event.detail,
      });
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
