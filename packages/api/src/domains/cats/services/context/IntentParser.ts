/**
 * Intent Parser
 * 从消息中解析 intent (ideate | execute) 和 prompt tags (#critique 等)。
 *
 * 规则:
 * 1. 显式 #ideate → ideate
 * 2. 显式 #execute → execute
 * 3. ≥2 猫且无显式 → ideate (并行独立思考)
 * 4. 1 猫且无显式 → execute (串行执行)
 * 额外: #critique → promptTags (改变思维方式，不改路由)
 */

export type Intent = 'ideate' | 'execute';

export interface IntentResult {
  readonly intent: Intent;
  /** Was the intent explicitly specified by user? */
  readonly explicit: boolean;
  /** Prompt-level tags like 'critique' */
  readonly promptTags: readonly string[];
}

/** Known intent tags (case-insensitive) */
export const INTENT_TAGS = ['ideate', 'execute'] as const satisfies readonly Intent[];

/** Known prompt tags (case-insensitive) */
export const PROMPT_TAGS = ['critique'] as const;

/** Tags that can appear before a route-line @mention */
export const ROUTE_CONTROL_TAGS = [...INTENT_TAGS, ...PROMPT_TAGS] as const;

const INTENT_TAG_SET = new Set<string>(INTENT_TAGS);
const PROMPT_TAG_SET = new Set<string>(PROMPT_TAGS);

/** Match #tag patterns in message text */
const TAG_PATTERN = /#(\w+)/gi;

/** Parse intent and prompt tags from a message */
export function parseIntent(message: string, targetCatCount: number): IntentResult {
  let explicitIntent: Intent | null = null;
  const promptTags: string[] = [];

  for (const match of message.matchAll(TAG_PATTERN)) {
    const tag = match[1]?.toLowerCase();
    if (INTENT_TAG_SET.has(tag)) {
      explicitIntent = tag as Intent;
    } else if (PROMPT_TAG_SET.has(tag)) {
      promptTags.push(tag);
    }
  }

  if (explicitIntent) {
    return { intent: explicitIntent, explicit: true, promptTags };
  }

  // Auto-infer: ≥2 cats → ideate, 1 cat → execute
  const intent: Intent = targetCatCount >= 2 ? 'ideate' : 'execute';
  return { intent, explicit: false, promptTags };
}

/** Remove intent and prompt tags from message text */
export function stripIntentTags(message: string): string {
  return message
    .replace(TAG_PATTERN, (full, tag) => {
      const lower = (tag as string).toLowerCase();
      if (INTENT_TAG_SET.has(lower) || PROMPT_TAG_SET.has(lower)) {
        return '';
      }
      return full;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
}
