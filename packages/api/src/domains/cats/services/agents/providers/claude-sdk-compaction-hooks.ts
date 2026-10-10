/**
 * F117 K2: the Agent SDK carrier's in-process Claude compaction hooks.
 *
 * SDK 0.3.280 awaits an in-process PreCompact callback before it compacts, fires SessionStart with
 * source 'compact' afterwards, and streams compact_boundary only once both returned
 * (f117-notes/phase2b-sdk-precompact). So the seal observation PreCompact records precedes the
 * boundary invoke-single-cat routes to F296, and the context packet SessionStart returns reaches the
 * model. Neither hook blocks the compaction: a failure is logged and the provider carries on, as
 * f24-pre-compact.sh does.
 */

import type { HookCallbackMatcher, HookEvent, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeCompactionHooks } from '../../types.js';

interface HookLog {
  warn(obj: unknown, msg?: string): void;
}

export function sdkCompactionHooks(
  hooks: ClaudeCompactionHooks,
  log: HookLog,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const preCompact = async (input: Parameters<HookCallbackMatcher['hooks'][number]>[0]): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreCompact') return {};
    try {
      await hooks.preCompact({ cliSessionId: input.session_id, trigger: input.trigger });
    } catch (err) {
      log.warn(
        { err, cliSessionId: input.session_id },
        'Claude SDK PreCompact hook failed; the compaction stays unproven',
      );
    }
    return {};
  };
  const sessionStart = async (input: Parameters<HookCallbackMatcher['hooks'][number]>[0]): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'SessionStart' || input.source !== 'compact') return {};
    try {
      const additionalContext = await hooks.postCompactContext({ cliSessionId: input.session_id });
      return additionalContext ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } } : {};
    } catch (err) {
      log.warn({ err, cliSessionId: input.session_id }, 'Claude SDK post-compact context unavailable');
      return {};
    }
  };
  return {
    PreCompact: [{ hooks: [preCompact] }],
    SessionStart: [{ hooks: [sessionStart] }],
  };
}
