import type { ProviderOutputMessage } from '@cat-cafe/shared';

/** Wire phase names stop here. Missing observations remain unknown, including on legacy CLI events. */
export function codexOutputMessage(
  event: Record<string, unknown>,
  item: Record<string, unknown>,
  hasDisplayPrefix: boolean,
): ProviderOutputMessage {
  return {
    provider: 'codex',
    ...(typeof event.thread_id === 'string' ? { runtimeSessionId: event.thread_id } : {}),
    ...(typeof event.turn_id === 'string' ? { turnId: event.turn_id } : {}),
    ...(typeof item.id === 'string' ? { nativeId: item.id } : {}),
    channel: item.phase === 'final_answer' ? 'final' : item.phase === 'commentary' ? 'commentary' : 'unknown',
    complete: true,
    textMode: 'replace',
    ...(hasDisplayPrefix ? { displayPrefixLength: 2 } : {}),
  };
}
