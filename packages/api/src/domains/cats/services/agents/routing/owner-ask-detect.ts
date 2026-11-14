/**
 * Owner ask without a line-start mention.
 *
 * The owner's mailbox only receives a cat message when it has a line-start
 * co-creator mention (`detectUserMention`). The 2026-11-09 census of 40k cat
 * messages found the other half of the dropped-ball problem: a cat ends its
 * message waiting for the owner to decide or act ("等你拍板", "你点头我就…",
 * "需要你重启一次"), routes to no cat, and never writes the mention. The owner
 * never sees it, the work stops, and days later the stall is reported as
 * "the owner did not reply". Interactive cards posted without a registered
 * decision have the same fate: only a person can click them, yet nothing
 * reaches the mailbox.
 *
 * This detector finds those messages so the producers can stop or correct them
 * (owner-ask-correction.ts); it never adds them to the mailbox. It stays narrow:
 * - text asks are read only from the final routing slot (last paragraph,
 *   signature, fences, quotes, blockquotes and URLs removed), the same slot the
 *   other routing checks use;
 * - a message already routed to a cat has a ball holder, so its text is not
 *   inferred as an owner ask (the routed cat can carry the dependency);
 * - negated, delegated ("请…向 You 确认"), conditional-future and
 *   pause-acknowledgement wording does not count.
 * Measured against 255 labelled census messages: precision 0.90, recall 0.80
 * (misses are mostly waits mentioned inside messages routed to a cat).
 */

import { getCoCreatorConfig } from '../../../../../config/cat-config-loader.js';
import { stripTrailingCatSignatures } from './cat-signature-strip.js';
import { finalRoutingSlot } from './final-routing-slot.js';

export type OwnerAskKind =
  | 'card'
  | 'wait'
  | 'need'
  | 'after'
  | 'not_yet'
  | 'choose'
  | 'wait_name'
  | 'owner_restart'
  | 'still_need';

export interface OwnerAskInput {
  readonly text: string;
  /** Line-start cat mentions or structured targetCats already carry this turn's ball. */
  readonly routedToCat: boolean;
  /** Rich blocks attached to the same message. Registered decision cards never pass through here. */
  readonly blocks?: readonly { readonly kind?: string }[];
  /** This turn already put a decision in front of the owner (approval card, decision card, scheduled-task proposal). */
  readonly openedOwnerDecision?: boolean;
}

const QUOTED = /`[^`\n]*`|「[^」]*」|“[^”]*”|"[^"\n]*"|『[^』]*』/g;
const PAUSE_ACK = /重启完成|恢复工作的?通知|暂停|停工|停手|安全(?:收住|停下|保存)/;
const CLAUSE_BREAK = /[，。,；;！!？?：:\n]/;
const NEGATION = /[不无没别未勿]/;
// 「请直接请co-creator拍板」「去向 You 确认」 hand the question to another cat.
const DELEGATED = /(?:请|让|叫|去)\s*(?:直接|先|你|他)?\s*(?:向|找|问|请|喊|发起|带去给)?\s*$/;
const CONDITIONAL = /(?:如果|要是|若|一旦|以后|将来|下次|有要你|随时)[^。！？\n]{0,12}$|有\s*$/;
// 「需要你拍板的地方他们会来找你」「需要你决定时再报」 name a later moment, not a pending request;
// 「需要你定的两件事」 still is one.
const LATER_TAIL = /^\s*(?:的(?:地方|时候)|时(?![间刻]))/;
// 「这次是你确认以后才交给小太阳的」「你点头后，设计稿都更新了」 tell what already happened.
const PAST_TAIL = /已经|已(?!经)|才|都[^。！？\n]{0,8}了/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ownerNamePattern(): string {
  const config = getCoCreatorConfig();
  const names = new Set([
    'co-creator',
    'operator',
    config.name,
    ...(config.nickname ? [config.nickname] : []),
    ...config.aliases,
  ]);
  return `(?:${[...names]
    .filter((name) => name.trim().length > 0)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|')})`;
}

function buildPatterns(): readonly { kind: OwnerAskKind; re: RegExp }[] {
  const name = ownerNamePattern();
  const who = `(?:你|${name})`;
  const act =
    '(?:拍板|决定|定夺|确认|点头|批准|审批|批|签字|签收|回复|回话|答复|回(?!来|家|去)|表态|过目|看完|看一?下|重启|授权|同意|放行|定|选|一句话|处理|给出|明确)';
  const make = (kind: OwnerAskKind, source: string) => ({ kind, re: new RegExp(source, 'gi') });
  return [
    make('wait', `(?:等|待|等着|等候|还等)\\s*${who}\\s*(?:的)?\\s*${act}`),
    make('need', `(?:需要|要|请|麻烦)\\s*${who}\\s*(?:来|先|亲自|帮忙)?\\s*${act}`),
    make(
      'after',
      `${who}\\s*(?:拍板|点头|批准|批了|确认|同意|决定|定了|定下来|签字|放行)\\s*(?:后|之后|以后|了我|我就|我再|了就|再)`,
    ),
    make('not_yet', `${who}\\s*(?:还没|还未|没)\\s*(?:回|批|定|确认|点头|拍板|表态)`),
    make('choose', '(?:要你|请你|你来)\\s*(?:定|选|拍板)|你定吧|二选一|三选一'),
    // 「等co-creator忙完/有空」 is about his own time, not a request waiting on him.
    make(
      'wait_name',
      `(?:等|待|在等|还在等|仍在等|仍待|还等)\\s*${name}(?!\\s*(?:忙完|有空|空了|休息|歇|睡|回来|下班|起床))`,
    ),
    make(
      'owner_restart',
      `${who}\\s*(?:先|方便的?时候|有空时?|只要在方便时)?\\s*(?:再)?\\s*重启(?!后|以后|之后|了|完|过)`,
    ),
    make(
      'still_need',
      '(?:还需要|还要|要|需要)\\s*你\\s*(?:来)?\\s*(?:处理|在场|看|点头|拍板|批|选|定|做一件|做两件|做几件)',
    ),
  ];
}

function isExcluded(slot: string, start: number, end: number, matched: string, kind: OwnerAskKind): boolean {
  const before = slot.slice(Math.max(0, start - 14), start);
  const after = slot.slice(end);
  // Negation counts only inside the same clause: 「不需要你拍板」 is not an ask, 「先不改，等你定」 is.
  if (NEGATION.test(before.split(CLAUSE_BREAK).pop() ?? '')) return true;
  if (DELEGATED.test(before) || CONDITIONAL.test(before) || LATER_TAIL.test(after)) return true;
  // 「汇总只写一致的、有分歧的、要你定的」 lists what something contains.
  if (/^\s*的/.test(after) && /、/.test(before.split(/[，。,；;！!？?：:\n]/).pop() ?? '')) return true;
  if (kind === 'after' && (/是\s*$/.test(before) || PAST_TAIL.test(after.split(/[。！？\n]/)[0] ?? ''))) return true;
  // 「等你看完…时，我…」 describes a later moment, not a pending request.
  return /^(?:等|待)/.test(matched) && /时[，,]/.test(after.slice(0, 12));
}

function matchTextAsk(text: string): OwnerAskKind | null {
  const slot = finalRoutingSlot(stripTrailingCatSignatures(text)).replace(QUOTED, '');
  if (!slot || PAUSE_ACK.test(slot)) return null;
  for (const { kind, re } of buildPatterns()) {
    for (const match of slot.matchAll(re)) {
      const start = match.index ?? 0;
      if (!isExcluded(slot, start, start + match[0].length, match[0], kind)) return kind;
    }
  }
  return null;
}

/** Returns why the message is an owner ask nobody addressed, or null. Callers skip it when a line-start mention exists. */
export function detectUnaddressedOwnerAsk(input: OwnerAskInput): OwnerAskKind | null {
  if (input.blocks?.some((block) => block.kind === 'interactive')) return 'card';
  if (input.routedToCat || input.openedOwnerDecision || !input.text) return null;
  return matchTextAsk(input.text);
}

function inputRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
}

/**
 * Whether one tool call put a decision in front of the owner through a channel his pending
 * decisions already show. A message that then says 「请批准上面那张卡」 needs no second mention.
 */
export function opensOwnerDecision(toolName: string, toolInput: unknown): boolean {
  if (/cat_cafe_propose_|cat_cafe_register_scheduled_task|cat_cafe_request_user_input/.test(toolName)) return true;
  const input = inputRecord(toolInput);
  if (toolName.includes('cat_cafe_create_rich_block')) return Boolean(input?.awaitResponseV1);
  if (toolName.includes('cat_cafe_cross_post_message')) return input?.effectClass === 'assign_work';
  return false;
}
