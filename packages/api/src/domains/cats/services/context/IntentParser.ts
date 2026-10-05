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
 * - 托付或获准开发/续做信号 → skill:custody-recognition (只唤醒政策，不拥有 Task/时间真相)
 */

import { classifyEntrustedWorkSourceTime } from '../../../growing/EntrustedWorkSourceSignals.js';

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
  /(?:准备|整理|制作|产出|完成|做完|跟进|跟踪|推进|处理|提交|交付|汇总|梳理|演示|展示|跑通|走通|demo|showcase|清单|方案|报告|手册|回来(?:给我|让我)|给我(?:一份|两个|结果))/iu;
const ZH_IMPLICIT_FUTURE = /(?:别忘了|不要忘了|记得|之后要|回头要|到时候要)/u;
const ZH_WORK_INTRO = /(?:有(?:个|件|一件)?(?:活(?:儿)?|任务|工作|事情?)|(?:这个|这件)(?:活(?:儿)?|任务|工作|事情?))/u;

const EN_STRONG_CUSTODY =
  /\b(?:take (?:this|it) (?:over|on)|own (?:this|the work)|you (?:handle|track|follow up on)|leave (?:this|it) (?:with|to) you)\b/i;
const EN_DELEGATION = /\b(?:could you|can you|please|i need you to|would you)\b/i;
const EN_DURABLE_OUTCOME =
  /\b(?:prepare|deliver|finish|complete|follow up|track|draft|compile|put together|demo|showcase|present|send me|come back with)\b/i;
const EN_IMPLICIT_FUTURE = /\b(?:don't forget|do not forget|remember to|later (?:we|i) need to)\b/i;
const EN_WORK_INTRO = /\b(?:there(?:'s| is) (?:a )?(?:task|job|piece of work)|(?:a|one) (?:task|job|piece of work))\b/i;

const DEVELOPMENT_ACTION =
  /^(?:(?:请|我们|你|今天|现在|马上|直接|尽快|立刻|就|先|麻烦你)\s*){0,2}(?:开始|着手|启动|继续|接着|恢复|重启|推进).{0,10}(?:开发|实现|Phase\s*[\w.+/-]+|阶段|F\d{3,}|这个(?:Feature|特性|项目|方案))/iu;
const DEVELOPMENT_APPROVAL =
  /^(?:这个|该)?(?:方案|Feature|阶段|Phase\s*[\w.+/-]+|F\d{3,}).{0,12}(?:通过|批准|同意).{0,10}(?:开工|开始做|开始开发|开始实现)/iu;
const DEVELOPMENT_CONTEXTUAL_ACTION = /^(?:现在|直接|就|可以)?\s*(?:开工|开始做|继续做|接着做)(?:吧|了|$)/u;
const DEVELOPMENT_URGENT_OUTCOME = /^(?:我|我们)?(?:希望|要|想).{0,18}(?:开发|实现).{0,6}(?:完成|做完|交付)/u;
const DEVELOPMENT_COMPLETION_DIRECT =
  /^(?:请|麻烦你|现在|直接|尽快)?\s*(?:完成|做完)\s*(?:F\d{3,}|Phase\s*[\w.+/-]+|(?:这个|该)?阶段)(?:的开发)?(?:吧|了)?$/iu;
const DEVELOPMENT_COMPLETION_OBJECT_FIRST =
  /^(?:请|现在|直接|尽快)?\s*把\s*(?:F\d{3,}|Phase\s*[\w.+/-]+|(?:这个|该)?阶段)\s*(?:完成|做完)(?:吧|了)?$/iu;
const DEVELOPMENT_NEGATION =
  /(?:不要|先别|别再|别|暂缓|暂停|停止|禁止|不能|不可|还不能|还没|尚未|不是让你|没让你|并非让你)[^，,。！？!?\n]{0,5}(?:开始|开工|开发|实现|继续|接着|恢复|推进)/u;
const DEVELOPMENT_DISCUSSION =
  /(?:如何|怎么|为什么|为何|什么时候|何时|哪天|是否|能否|要不要|可不可以|需不需要|请分析|先讨论|先评估|先考虑|先研究|只是举例|只是测试|只是引用|不是让你执行)/u;
const DEVELOPMENT_GOAL_STATUS = /(?:是|作为|属于).{0,8}(?:目标|计划|愿望|议题|状态)/u;
const DEVELOPMENT_CONDITION_RELEASE =
  /(?:不(?:用|必|需要|要)?|无(?:需|须)|先别|别)\s*等(?:待|到)?(?:方案|批准|确认|评估)?(?:通过|完成)?(?:了)?/u;
const DEVELOPMENT_CONDITIONAL =
  /(?:如果|假如|要是|除非|等(?:到|方案|批准|确认|评估)|待(?:方案|批准|确认)|(?:通过|批准|确认)后)/u;
const DEVELOPMENT_REPORTED = /^(?:他|她|用户|文档|记录|笔记|日志|You).{0,12}(?:说过|说|提过|提到|写着|写道|记着)/u;
const LEADING_CONTROL_PREFIX = /^\s*(?:(?:@[\p{L}\p{N}_.-]+|#(?:ideate|execute|critique))\s+)+/iu;
const DEVELOPMENT_SIGNALS = [
  DEVELOPMENT_ACTION,
  DEVELOPMENT_APPROVAL,
  DEVELOPMENT_CONTEXTUAL_ACTION,
  DEVELOPMENT_URGENT_OUTCOME,
  DEVELOPMENT_COMPLETION_DIRECT,
  DEVELOPMENT_COMPLETION_OBJECT_FIRST,
];

function isActionableDevelopmentClause(text: string): boolean {
  if (!text || /(?:吗|呢)$/u.test(text)) return false;
  if (DEVELOPMENT_NEGATION.test(text) || DEVELOPMENT_DISCUSSION.test(text) || DEVELOPMENT_GOAL_STATUS.test(text)) {
    return false;
  }
  return DEVELOPMENT_SIGNALS.some((signal) => signal.test(text));
}

function resolveDevelopmentCondition(text: string, pending: boolean): { pending: boolean; actionText: string } {
  if (DEVELOPMENT_CONDITION_RELEASE.test(text)) {
    return { pending: false, actionText: text.replace(DEVELOPMENT_CONDITION_RELEASE, '').trim() };
  }
  return { pending: pending || DEVELOPMENT_CONDITIONAL.test(text), actionText: text };
}

function hasActionableDevelopmentSentence(sentence: string): boolean {
  if (/[？?]\s*$/u.test(sentence)) return false;
  // Pending conditions and reported speech cover later comma clauses. A new
  // sentence resets both; refusals, questions, and goals stay clause-local.
  let conditional = false;
  let reported = false;
  for (const clause of sentence.split(/[，,]/u)) {
    const text = clause.replace(/[。！!；;]+$/u, '').trim();
    if (DEVELOPMENT_REPORTED.test(text)) reported = true;
    if (reported) continue;
    const condition = resolveDevelopmentCondition(text, conditional);
    conditional = condition.pending;
    if (!conditional && isActionableDevelopmentClause(condition.actionText)) return true;
  }
  return false;
}

function containsDevelopmentStartSignal(message: string): boolean {
  // The parser sees only this message, not accepted scope. Wake the policy on an
  // actionable sentence; the original owner still checks source and authority.
  const unquoted = message
    .replace(LEADING_CONTROL_PREFIX, '')
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/^\s*>.*$/gmu, '')
    .replace(/`[^`\n]*`/gu, '')
    .replace(/[“「『‘"][^”」』’"\n]*[”」』’"]/gu, '');
  return (unquoted.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) ?? []).some(hasActionableDevelopmentSentence);
}

function hasCustodyTimeCue(message: string): boolean {
  const relation = classifyEntrustedWorkSourceTime(message);
  // Ambiguity may warrant reading the policy, but this cue grants no Task authority.
  return relation === 'deadline' || relation === 'ambiguous';
}

function shouldWakeCustodyRecognition(message: string): boolean {
  if (ZH_STRONG_CUSTODY.test(message) || EN_STRONG_CUSTODY.test(message)) return true;

  const hasTimeSignal = hasCustodyTimeCue(message);
  const explicitTimeBound =
    ((ZH_DELEGATION.test(message) && ZH_DURABLE_OUTCOME.test(message)) ||
      (EN_DELEGATION.test(message) && EN_DURABLE_OUTCOME.test(message))) &&
    hasTimeSignal;
  if (explicitTimeBound) return true;

  const introducedTimeBoundWork =
    ((ZH_WORK_INTRO.test(message) && ZH_DURABLE_OUTCOME.test(message)) ||
      (EN_WORK_INTRO.test(message) && EN_DURABLE_OUTCOME.test(message))) &&
    hasTimeSignal;
  if (introducedTimeBoundWork) return true;

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

  if (containsDevelopmentStartSignal(message) || shouldWakeCustodyRecognition(message)) {
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
