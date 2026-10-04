export type EntrustedWorkTimeRelation = 'none' | 'deadline' | 'historical_reference' | 'ambiguous';

const ZH_TIME_BOUND =
  /(?:今天|今晚|明天|后天|本周|这周|下周|周[一二三四五六日天]|月底|月末|年底|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|\d{1,2}\s*(?:点|时)(?:\s*\d{1,2}\s*分)?|以内|截止|到期|deadline)/iu;
const EN_TIME_BOUND =
  /\b(?:today|tonight|tomorrow|next week|this week|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)|deadline|due )\b/i;

const ZH_PAST_REFERENCE = /(?:很久|很早|过去|以前|此前|先前|上次|当时|原来|曾经)/u;
const ZH_PAST_ACTION =
  /(?:已经|曾经|过去|以前|此前|先前|上次|当时|原来|(?:讨论|说|做|完成|提交|交付|处理|准备|发布|发|聊|看|改|审|批准|验收|整理|定|去|来)(?:过|了))/u;
const ZH_REPORTED = /(?:说过|提过|写着|写道|记着|记录着|(?:他|她|用户).{0,8}说)/u;
const ZH_RETURN = /^(?:(?:请|要|麻烦你)\s*)?(?:回到|返回到?|恢复到|退回到|切回到|回溯到)/u;
const ZH_PROSPECTIVE_MODAL =
  /^(?:(?:我们|你们|我|你|现在|如今|接下来)\s*){0,2}(?:请|要|必须|需要|务必|应当|应该|尽量|麻烦你)/u;
const ZH_CURRENT_RESET = /^(?:但|不过|而)?(?:现在|如今)/u;
const ZH_CONTRAST = /(?:但|不过|然而|可是|而)/u;
const ZH_PERSON_ONLY = /^(?:我|我们|你|你们|他|他们|她|她们)$/u;

const EN_HISTORICAL_CLAUSE =
  /^(?:(?:already|previously|earlier|yesterday|once)\b|(?:i|we|you|they|he|she|it|the\s+\w+|a\s+\w+|an\s+\w+)\s+(?:already\s+)?(?:had|did|was|were|said|wrote|mentioned|reported|\w+ed)\b)/i;
const EN_REPORTED = /\b(?:said|says|wrote|writes|noted|notes|reported|reports|mentioned|mentions|states)\b/i;
const EN_CURRENT_RESET = /^(?:(?:but|and)\s+)?now\b/i;
const EN_CONTRAST = /\b(?:but|however|yet)\b/i;
const EN_LOCAL_MODAL = /\b(?:must|should|will|shall|need(?:s)? to|have to)\b/i;
const EN_FUTURE_OBLIGATION = /\b(?:agreed|planned|promised|intended|expected|supposed|scheduled)\s+to\s+\w+/i;
const EN_TO_COMPLEMENT = /\bto\s+\w+(?:\s+\w+){0,5}$/i;
const EN_RETURN = /\b(?:go back|return|revert|restore|roll back)\s+to\b/i;
const EN_BARE_PRIOR_TARGET = /\b(?:go back|return|revert|restore|roll back)\s+to\s*(?:(?:just|right|\w+ly)\s*)?$/i;
const EN_STATE_REFERENCE_TARGET = /\b(?:go back|return)\s+to\s+(?:the|a|an)\s+(?:[\w-]+\s+){0,4}state$/i;

function combine(a: EntrustedWorkTimeRelation, b: EntrustedWorkTimeRelation): EntrustedWorkTimeRelation {
  if (a === 'deadline' || b === 'deadline') return 'deadline';
  if (a === 'ambiguous' || b === 'ambiguous') return 'ambiguous';
  if (a === 'historical_reference' || b === 'historical_reference') return 'historical_reference';
  return 'none';
}

function localModality(prefix: string, afterModal: boolean, contrast: RegExp, reset: RegExp, modal: RegExp) {
  const tail = prefix.split(contrast).at(-1)?.trim() ?? prefix;
  const prospective = modal.test(tail) || afterModal;
  const currentShift = reset.test(prefix) || (tail !== prefix && prospective);
  return { prospective, currentShift, reportedPrefix: currentShift ? tail : prefix };
}

function reportedInScope(prefix: string, attributionClause: string, currentShift: boolean, reported: RegExp) {
  return reported.test(prefix) || (!currentShift && reported.test(attributionClause));
}

function englishPastMatrix(preceding: string): EntrustedWorkTimeRelation | undefined {
  if (!EN_HISTORICAL_CLAUSE.test(preceding)) return undefined;
  return EN_TO_COMPLEMENT.test(preceding) ? 'ambiguous' : 'historical_reference';
}

function englishAfterModal(preceding: string, following: string, action: string | undefined): boolean {
  const contrastive = EN_CONTRAST.test(preceding);
  const actionModal = Boolean(action && EN_LOCAL_MODAL.test(action));
  return (
    (actionModal && (!EN_HISTORICAL_CLAUSE.test(preceding) || contrastive)) ||
    (contrastive && EN_LOCAL_MODAL.test(following))
  );
}

function classifyChineseMarker(leading: string, prefix: string, following: string): EntrustedWorkTimeRelation {
  const attributionClause = leading.split(/[，,]/u).at(-2)?.trim() ?? '';
  const event = prefix.replace(/^(?:(?:请|务必|尽量|我|我们|要)\s*)*(?:在|于)\s*/u, '').trim();
  const action = following
    .replace(/^[，,]\s*/u, '')
    .split(/[，,]/u)[0]
    .trim();
  const modality = localModality(
    prefix,
    ZH_PROSPECTIVE_MODAL.test(action),
    ZH_CONTRAST,
    ZH_CURRENT_RESET,
    ZH_PROSPECTIVE_MODAL,
  );
  if (
    reportedInScope(modality.reportedPrefix, attributionClause, modality.currentShift, ZH_REPORTED) ||
    /^的/u.test(following)
  ) {
    return 'historical_reference';
  }
  if (!event || ZH_PERSON_ONLY.test(event) || event.endsWith('的')) {
    return 'historical_reference';
  }
  if (ZH_RETURN.test(prefix)) return 'ambiguous';
  if (modality.prospective) return 'deadline';
  if (ZH_PAST_REFERENCE.test(event)) return event.includes('的') ? 'ambiguous' : 'historical_reference';
  return ZH_PAST_ACTION.test(action) ? 'historical_reference' : 'deadline';
}

function chineseBeforeRelation(sentence: string): EntrustedWorkTimeRelation {
  let result: EntrustedWorkTimeRelation = 'none';
  let segmentStart = 0;
  for (const match of sentence.matchAll(/之前/gu)) {
    const leading = sentence.slice(0, match.index);
    const prefix = leading.slice(segmentStart).split(/[，,]/u).at(-1)?.trim() ?? '';
    segmentStart = match.index + match[0].length;
    const following = sentence.slice(segmentStart).trimStart();
    result = combine(result, classifyChineseMarker(leading, prefix, following));
    if (result === 'deadline') return result;
  }
  return result;
}

function classifyEnglishMarker(leading: string, preceding: string, following: string): EntrustedWorkTimeRelation {
  const attributionClause = leading.split(/[,，]/u).at(-2)?.trim() ?? '';
  const [event, action] = following.split(/,\s*/u, 2);
  const afterModal = englishAfterModal(preceding, following, action);
  const modality = localModality(preceding, afterModal, EN_CONTRAST, EN_CURRENT_RESET, EN_LOCAL_MODAL);
  if (reportedInScope(modality.reportedPrefix, attributionClause, modality.currentShift, EN_REPORTED)) {
    return 'historical_reference';
  }
  if (EN_BARE_PRIOR_TARGET.test(preceding) || EN_STATE_REFERENCE_TARGET.test(preceding)) {
    return 'historical_reference';
  }
  if (EN_RETURN.test(preceding)) return 'ambiguous';
  if (modality.prospective) return 'deadline';
  if (EN_FUTURE_OBLIGATION.test(preceding)) return 'deadline';
  const pastMatrix = englishPastMatrix(preceding);
  if (pastMatrix) return pastMatrix;
  if (!event || EN_HISTORICAL_CLAUSE.test(event) || (action && EN_HISTORICAL_CLAUSE.test(action))) {
    return 'historical_reference';
  }
  return 'deadline';
}

function englishBeforeRelation(sentence: string): EntrustedWorkTimeRelation {
  let result: EntrustedWorkTimeRelation = 'none';
  let segmentStart = 0;
  for (const match of sentence.matchAll(/\bbefore\b/giu)) {
    const leading = sentence.slice(0, match.index);
    const preceding = sentence.slice(segmentStart, match.index).split(/[,，]/u).at(-1)?.trim() ?? '';
    segmentStart = match.index + match[0].length;
    const following = sentence.slice(segmentStart).trim();
    result = combine(result, classifyEnglishMarker(leading, preceding, following));
    if (result === 'deadline') return result;
  }
  return result;
}

/** Classify source time without turning an unresolved relative phrase into an invented deadline. */
export function classifyEntrustedWorkSourceTime(message: string): EntrustedWorkTimeRelation {
  if (ZH_TIME_BOUND.test(message) || EN_TIME_BOUND.test(message)) return 'deadline';
  let result: EntrustedWorkTimeRelation = 'none';
  for (const sentence of message.match(/[^。！？!?；;\n]+/gu) ?? []) {
    result = combine(result, chineseBeforeRelation(sentence));
    result = combine(result, englishBeforeRelation(sentence));
    if (result === 'deadline') return result;
  }
  return result;
}
