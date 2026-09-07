/**
 * Intent Parser
 * 从消息中解析 intent (ideate | execute) 和 prompt tags (#critique 等)。
 *
 * 规则:
 * 1. 显式 #ideate → ideate
 * 2. 显式 #execute → execute
 * 3. ≥2 猫且无显式 → ideate (并行独立思考)
 * 4. 1 猫且无显式 → execute (串行执行)
 * 额外:
 * - #critique → promptTags (改变思维方式，不改路由)
 * - 强托付信号 → skill:custody-recognition (只唤醒政策，不拥有 Task/时间真相)
 */

import { containsEntrustedWorkTimeSignal } from '../../../growing/EntrustedWorkSourceSignals.js';

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
const CUSTODY_RECOGNITION_SKILL_TAG = 'skill:custody-recognition';

/** Match #tag patterns in message text */
const TAG_PATTERN = /#(\w+)/gi;

const ZH_STRONG_CUSTODY =
  /(?:帮我(?:接住|跟进|跟踪|盯(?:住|着)|负责)|这(?:件|个)事(?:情)?(?:就)?你来|交给你(?:来)?|你来(?:负责|跟进|跟踪|推进|处理))/u;
const ZH_DELEGATION = /(?:帮我|请你|麻烦你|劳烦你|替我)/u;
const ZH_DURABLE_OUTCOME =
  /(?:准备|整理|制作|产出|完成|做完|跟进|跟踪|推进|处理|提交|交付|汇总|梳理|清单|方案|报告|手册|回来(?:给我|让我)|给我(?:一份|两个|结果))/u;
const ZH_IMPLICIT_FUTURE = /(?:别忘了|不要忘了|记得|之后要|回头要|到时候要)/u;

const EN_STRONG_CUSTODY =
  /\b(?:take (?:this|it) (?:over|on)|own (?:this|the work)|you (?:handle|track|follow up on)|leave (?:this|it) (?:with|to) you)\b/i;
const EN_DELEGATION = /\b(?:could you|can you|please|i need you to|would you)\b/i;
const EN_DURABLE_OUTCOME =
  /\b(?:prepare|deliver|finish|complete|follow up|track|draft|compile|put together|send me|come back with)\b/i;
const EN_IMPLICIT_FUTURE = /\b(?:don't forget|do not forget|remember to|later (?:we|i) need to)\b/i;

function shouldWakeCustodyRecognition(message: string): boolean {
  if (ZH_STRONG_CUSTODY.test(message) || EN_STRONG_CUSTODY.test(message)) return true;

  const explicitTimeBound =
    ((ZH_DELEGATION.test(message) && ZH_DURABLE_OUTCOME.test(message)) ||
      (EN_DELEGATION.test(message) && EN_DURABLE_OUTCOME.test(message))) &&
    containsEntrustedWorkTimeSignal(message);
  if (explicitTimeBound) return true;

  return (
    (ZH_IMPLICIT_FUTURE.test(message) && ZH_DURABLE_OUTCOME.test(message)) ||
    (EN_IMPLICIT_FUTURE.test(message) && EN_DURABLE_OUTCOME.test(message))
  );
}

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

  if (shouldWakeCustodyRecognition(message)) {
    promptTags.push(CUSTODY_RECOGNITION_SKILL_TAG);
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
